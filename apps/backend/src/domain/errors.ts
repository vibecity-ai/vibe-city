export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class InvalidInputError extends Error {}
/** A service we depend on (OutLayer) is down or answered with an error that is not the caller's fault. */
export class UpstreamError extends Error {}
