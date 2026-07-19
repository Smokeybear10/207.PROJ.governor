import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { createDemoRun, getDemoCatalog } from "./demo/index.js";
import { ApiError, errorMessage } from "./errors.js";
import { runRepairDemo } from "./repair/api.js";
import { RepositoryRepairRuns } from "./repair/repository-runs.js";
import { resolveProviderMode, type ProviderMode } from "./openai/provider-factory.js";
import { GovernedJobService } from "./jobs/index.js";
import type { JobStore } from "./jobs/store.js";
import { OpenAiResponsesClient } from "./openai/index.js";
import type { ResponsesProvider } from "./runtime/index.js";

const BODY_LIMIT = "256kb";
const LOOPBACK_REQUEST_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type CreateAppOptions = {
  readonly provider?: ResponsesProvider | null;
  readonly jobIdFactory?: () => string;
  readonly now?: () => Date;
  readonly exposeGovernedApi?: boolean;
  readonly forcedRepairMode?: ProviderMode;
  readonly jobStore?: JobStore;
  readonly repairStore?: JobStore;
};

function applySecurityHeaders(
  _request: Request,
  response: Response,
  next: () => void
): void {
  response.set({
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  next();
}

function requestHostname(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined) {
    return null;
  }
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function requireLocalRequest(
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  const hostname = requestHostname(request.headers.host);
  if (hostname === null || !LOOPBACK_REQUEST_HOSTS.has(hostname)) {
    next(
      new ApiError(
        "HOST_NOT_ALLOWED",
        "The local Governor API accepts loopback Host headers only.",
        403
      )
    );
    return;
  }
  if (request.headers.origin !== undefined) {
    next(
      new ApiError(
        "BROWSER_ORIGIN_NOT_ALLOWED",
        "Browser-origin requests are not accepted by the local Governor API.",
        403
      )
    );
    return;
  }
  next();
}

function requestCancellation(
  request: Request,
  response: Response
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("The API client disconnected."));
    }
  };
  const close = (): void => {
    if (!response.writableEnded) {
      abort();
    }
  };
  request.once("aborted", abort);
  response.once("close", close);
  return {
    signal: controller.signal,
    dispose(): void {
      request.off("aborted", abort);
      response.off("close", close);
    }
  };
}

const handleError: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next
) => {
  if (error instanceof ApiError) {
    response
      .status(error.status)
      .json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined
            ? {}
            : { details: error.details })
        }
      });
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    response.status(413).json({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "The request body exceeds the configured size limit."
      }
    });
    return;
  }

  if (
    error instanceof SyntaxError &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 400
  ) {
    response.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "The request body must be valid JSON."
      }
    });
    return;
  }

  console.error(errorMessage(error));
  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed."
    }
  });
};

function configuredProvider(): ResponsesProvider | undefined {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  return new OpenAiResponsesClient({ apiKey });
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const exposeGovernedApi = options.exposeGovernedApi ?? true;
  const provider =
    options.provider === null
      ? undefined
      : (options.provider ?? configuredProvider());
  const jobs = new GovernedJobService({
    store: options.jobStore,
    ...(provider === undefined ? {} : { provider }),
    ...(options.jobIdFactory === undefined
      ? {}
      : { idFactory: options.jobIdFactory }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const repositoryRuns = new RepositoryRepairRuns(jobs, options.repairStore);
  app.disable("x-powered-by");
  app.use(applySecurityHeaders);
  app.use(requireLocalRequest);
  app.use("/api/repair/repository", express.json({ limit: "1mb" }));
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get("/api/health", (_request, response) => {
    response.json({
      service: "token-governor",
      status: "ready",
      mode: "demo",
      providerConfigured: provider !== undefined,
      governedApi: exposeGovernedApi
    });
  });

  app.get("/api/demo/catalog", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(getDemoCatalog());
  });

  app.post("/api/demo/runs", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.status(201).json(createDemoRun(request.body));
  });

  app.post("/api/repair/runs", async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    const body: unknown = request.body ?? {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      next(new ApiError("INVALID_REPAIR_INPUT", "Request body must be an object.", 400));
      return;
    }
    const record = body as Record<string, unknown>;
    const fixtureId =
      record.fixtureId === undefined ? undefined : String(record.fixtureId);
    let mode: ProviderMode | undefined;
    try {
      mode =
        record.mode === undefined
          ? undefined
          : resolveProviderMode(String(record.mode));
    } catch (error) {
      next(new ApiError("INVALID_PROVIDER_MODE", errorMessage(error), 400));
      return;
    }
    if (
      options.forcedRepairMode !== undefined &&
      mode !== undefined &&
      mode !== options.forcedRepairMode
    ) {
      next(
        new ApiError(
          "REPAIR_MODE_NOT_AVAILABLE",
          `This deployment only supports "${options.forcedRepairMode}" repair mode.`,
          400
        )
      );
      return;
    }
    mode = options.forcedRepairMode ?? mode;
    const cancellation = requestCancellation(request, response);
    try {
      const result = await runRepairDemo({
        fixtureId,
        mode,
        signal: cancellation.signal,
        createService: (repairProvider) => jobs.withProvider(repairProvider)
      });
      if (!cancellation.signal.aborted) {
        response.status(201).json(result);
      }
    } catch (error) {
      if (!cancellation.signal.aborted) {
        next(new ApiError("REPAIR_RUN_FAILED", errorMessage(error), 400));
      }
    } finally {
      cancellation.dispose();
    }
  });

  app.use("/api/repair/repository", (_request, _response, next) => {
    if (!exposeGovernedApi || (options.forcedRepairMode !== undefined && options.forcedRepairMode !== "live")) {
      next(new ApiError("NOT_FOUND", "Repository repair is not enabled on this service.", 404));
      return;
    }
    next();
  });
  app.post("/api/repair/repository/runs", (request, response) => {
    response.set("Cache-Control", "no-store");
    if (!provider) throw new ApiError("PROVIDER_NOT_CONFIGURED", "Set an OpenAI API key before repairing a workspace. The sample demo does not repair your files.", 503);
    response.status(202).json(repositoryRuns.start(request.body));
  });
  app.get("/api/repair/repository/runs/:requestId", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(repositoryRuns.get(request.params.requestId));
  });

  if (!exposeGovernedApi) {
    app.use("/v1", (_request, _response, next) => {
      next(new ApiError("NOT_FOUND", "The API route does not exist.", 404));
    });
  }

  app.post("/v1/jobs", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.status(201).json(jobs.createJob(request.body));
  });

  app.get("/v1/jobs", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(jobs.listJobs(request.query));
  });

  app.get("/v1/jobs/:jobId", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(jobs.getJob(request.params.jobId));
  });

  app.get("/v1/jobs/:jobId/report", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(jobs.getReport(request.params.jobId));
  });

  app.get(
    "/v1/jobs/:jobId/responses/:requestId",
    async (request, response) => {
      response.set("Cache-Control", "no-store");
      const result = await jobs.getResponse(
        request.params.jobId,
        request.params.requestId
      );
      response.status(result.statusCode).json(result.body);
    }
  );

  app.post(
    "/v1/jobs/:jobId/quote",
    async (request, response, next) => {
      response.set("Cache-Control", "no-store");
      const cancellation = requestCancellation(request, response);
      try {
        const quote = await jobs.quoteResponse(request.params.jobId, request.body, cancellation.signal);
        if (!cancellation.signal.aborted) response.json(quote);
      } catch (error) {
        if (!cancellation.signal.aborted) next(error);
      } finally {
        cancellation.dispose();
      }
    }
  );

  app.post(
    "/v1/jobs/:jobId/responses",
    async (request, response, next) => {
      response.set("Cache-Control", "no-store");
      const cancellation = requestCancellation(request, response);
      try {
        const result = await jobs.createResponse(
          request.params.jobId,
          request.body,
          cancellation.signal,
          { continueAfterDispatch: true }
        );
        if (!cancellation.signal.aborted) {
          response.status(result.statusCode).json(result.body);
        }
      } catch (error) {
        if (!cancellation.signal.aborted) {
          next(error);
        }
      } finally {
        cancellation.dispose();
      }
    }
  );

  app.post("/v1/jobs/:jobId/finalize", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(jobs.finalizeJob(request.params.jobId, request.body));
  });

  app.use("/v1", (_request, _response, next) => {
    next(new ApiError("NOT_FOUND", "The API route does not exist.", 404));
  });

  app.use("/api", (_request, _response, next) => {
    next(new ApiError("NOT_FOUND", "The API route does not exist.", 404));
  });

  app.use(handleError);
  return app;
}
