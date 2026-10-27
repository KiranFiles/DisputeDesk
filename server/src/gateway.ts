// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export class PayPalError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type AcceptReason =
  | "REASON_NOT_SET"
  | "NOT_ABLE_TO_WIN"
  | "COMPANY_POLICY"
  | "DID_NOT_SHIP_ITEM"
  | "LOST_IN_MAIL";

export interface PayPalGateway {
  listDisputes(): Promise<Json[]>;
  getDispute(id: string): Promise<Json>;
  /** Looks up the seller transaction behind a dispute. */
  getTransaction(transactionId: string, disputeCreatedAt: string): Promise<Json | null>;
  acceptClaim(id: string, note: string, reason: AcceptReason): Promise<Json>;
  sendMessage(id: string, message: string): Promise<Json>;
  provideEvidence(
    id: string,
    notes: string,
    tracking?: { carrier: string; trackingNumber: string },
  ): Promise<Json>;
}
