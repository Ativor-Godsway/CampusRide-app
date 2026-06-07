export interface Driver {
  id: string;
  userId: string;
  carMake: string;
  carModel: string;
  carColor: string;
  plate: string;
  photoUrl: string;
  isApproved: boolean;
  isOnline: boolean;
  currentZoneId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
