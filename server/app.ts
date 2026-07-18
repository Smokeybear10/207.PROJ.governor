import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response
} from "express";
import { createDemoRun, getDemoCatalog } from "./demo/index.js";
import { ApiError, errorMessage } from "./errors.js";
import { runRepairDemo } from "./repair/api.js";
import { resolveProviderMode, type ProviderMode } from "./openai/provider-factory.js";
import { GovernedJobService } from "./jobs/index.js";
import { OpenAiResponsesClient } from "./openai/index.js";
import type { ResponsesProvider } from "./runtime/index.js";

const BODY_LIMIT = "256kb";

export type CreateAppOptions = {
  readonly provider?: ResponsesProvider | null;
  readonly jobIdFactory?: () => string;
  readonly now?: () => Date;
  readonly exposeGovernedApi?: boolean;
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
        message: `Request bodies are limited to ${BODY_LIMIT}.`
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
    ...(provider === undefined ? {} : { provider }),
    ...(options.jobIdFactory === undefined
      ? {}
      : { idFactory: options.jobIdFactory }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  app.disable("x-powered-by");
  app.use(applySecurityHeaders);
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

  app.post("/api/repair/runs", (request, response, next) => {
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
    runRepairDemo({ fixtureId, mode })
      .then((result) => {
        response.status(201).json(result);
      })
      .catch((error: unknown) => {
        next(new ApiError("REPAIR_RUN_FAILED", errorMessage(error), 400));
      });
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

  app.get("/v1/jobs/:jobId", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json(jobs.getJob(request.params.jobId));
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
    "/v1/jobs/:jobId/responses",
    async (request, response) => {
      response.set("Cache-Control", "no-store");
      const result = await jobs.createResponse(
        request.params.jobId,
        request.body
      );
      response.status(result.statusCode).json(result.body);
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
