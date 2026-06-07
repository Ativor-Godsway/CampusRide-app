export type PaymentType = "COLLECTION" | "DISBURSEMENT" | "REFUND";

export type PaymentRecordStatus = "PENDING" | "SUCCESS" | "FAILED";

export interface Payment {
  id: string;
  rideId: string;
  riderId: string;
  /** Amount in pesewas (integer). GHS 1 = 100 pesewas. Never use floats for money. */
  amount: number;
  type: PaymentType;
  status: PaymentRecordStatus;
  providerRef: string | null;
  createdAt: Date;
}
