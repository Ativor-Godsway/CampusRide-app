export type UserRole = "RIDER" | "DRIVER" | "ADMIN";

export interface User {
  id: string;
  phone: string;
  name: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}
