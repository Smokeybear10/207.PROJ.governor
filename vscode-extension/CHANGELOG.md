# Changelog

## 0.2.0

- Save jobs, spending, reservations, and responses across service restarts.
- Browse saved jobs, reopen responses, and export spending reports.
- Preview request costs and enforce the approved spending ceiling.
- Repair selected workspace Node tests in an isolated snapshot, review diffs,
  and apply proposals as unsaved editor changes.
- Reopen saved repairs without sending another model request.
- Bundle and manage the loopback Governor service inside the extension.
- Store the optional OpenAI API key in VS Code Secret Storage.
- Add request timeouts, cancellation, stale-job recovery, and server restart
  recovery.
- Harden the local API against browser-origin and DNS-rebinding requests.
- Validate API responses and webview actions before rendering them.
- Redesign the job view with clearer service, provider, budget, and repair
  states plus native view-title actions.
- Validate jobs before switching, cap recent-job history, and normalize
  integer timeout and polling settings.

## 0.1.0

- Initial Marketplace release with governed jobs, spend tracking, prompts,
  editor selections, finalization, and deterministic CI-repair.
