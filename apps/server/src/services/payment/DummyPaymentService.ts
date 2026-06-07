import type { PaymentResult, PaymentService } from "./PaymentService";

export class DummyPaymentService implements PaymentService {
  async collect(rideId: string, _amount: number): Promise<PaymentResult> {
    return { success: true, providerRef: `dummy-collect-${rideId}` };
  }

  async disburse(driverPhone: string, _amount: number): Promise<PaymentResult> {
    return { success: true, providerRef: `dummy-disburse-${driverPhone}` };
  }
}
