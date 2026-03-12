export class RelaySessionDeliveryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(input: { code: string; message: string; status: number }) {
    super(input.message);
    this.name = "RelaySessionDeliveryError";
    this.code = input.code;
    this.status = input.status;
  }
}

export class RelayQueueFullError extends Error {
  readonly code = "PROXY_RELAY_QUEUE_FULL";
  readonly status = 507;

  constructor() {
    super("Target relay queue is full");
    this.name = "RelayQueueFullError";
  }
}
