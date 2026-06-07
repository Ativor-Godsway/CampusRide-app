export interface PaymentResult {
  success: boolean;
  providerRef: string;
}

export interface PaymentService {
  /** Collect fare from a rider for a given ride. Amount in pesewas. */
  collect(rideId: string, amount: number): Promise<PaymentResult>;
  /** Disburse driver share to a driver phone. Amount in pesewas. */
  disburse(driverPhone: string, amount: number): Promise<PaymentResult>;
}
