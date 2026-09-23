import { File } from "expo-file-system";
import { api } from "../auth/apiClient";

/**
 * Cloudinary image upload — SIGNED, via a server-issued ticket.
 *
 * Previously this used an UNSIGNED upload preset whose name shipped in the
 * app bundle (EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET). Anyone who unpacked the
 * app could extract it and upload arbitrary files into the Cloudinary
 * account, with no authentication and no attribution.
 *
 * Now the app holds no Cloudinary credential at all. It asks the API for a
 * short-lived signature (POST /uploads/driver-photo/signature, driver-only),
 * and Cloudinary refuses any upload whose parameters don't match what the
 * server signed — the folder, the driver's own public id, the accepted
 * formats and the stored dimensions are all fixed server-side.
 */

/** Mirrors the server's DriverPhotoUploadTicket. */
interface UploadTicket {
  cloudName: string;
  apiKey: string;
  uploadUrl: string;
  params: Record<string, string | number | boolean>;
  signature: string;
  maxBytes: number;
  allowedFormats: string[];
}

/**
 * Whether photo upload is available.
 *
 * Always true now: there is nothing to configure in the app, and whether
 * uploads actually work is a server-side question answered by the signature
 * endpoint (503 UPLOADS_NOT_CONFIGURED). Kept as a function so existing call
 * sites keep working.
 */
export function isCloudinaryConfigured(): boolean {
  return true;
}

/**
 * React Native's FormData type models only `string | { uri, name, type }`
 * parts and a two-argument `append` — it predates Blob support and describes
 * the XHR transport, not Expo's.
 *
 * At runtime the object IS capable of more: RN's FormData stores whatever it
 * is given, and expo/fetch's multipart encoder then accepts strings, Blobs,
 * and anything exposing `bytes()`. expo-file-system's `File` extends
 * `FileSystemFile`, which declares `bytes(): Promise<Uint8Array>`, so it
 * encodes correctly.
 *
 * This view expresses that gap in one place, rather than scattering
 * `as unknown as Blob` casts that would claim something untrue about the value.
 */
interface MultipartFormData {
  append(name: string, value: unknown, fileName?: string): void;
}

function multipart(formData: FormData): MultipartFormData {
  return formData as unknown as MultipartFormData;
}

/** Derives the upload filename/extension from the local URI, defaulting to jpg. */
function fileNameFor(localUri: string, allowedFormats: string[]): string {
  const match = /\.([a-zA-Z0-9]+)(?:\?.*)?$/.exec(localUri);
  const ext = match?.[1]?.toLowerCase();
  const safeExt = ext && allowedFormats.includes(ext) ? ext : "jpg";
  return `profile.${safeExt}`;
}

/**
 * Uploads a local image URI to Cloudinary using a server-signed ticket and
 * returns the resulting `secure_url`.
 *
 * `sizeBytes`, when the picker provides it, is checked against the server's
 * limit before the upload starts — that is a courtesy to the user (fail fast
 * on a huge file), not the security boundary; the real constraints are the
 * signed parameters Cloudinary enforces.
 */
export async function uploadImageToCloudinary(
  localUri: string,
  sizeBytes?: number,
): Promise<string> {
  const { data: ticket } = await api.post<UploadTicket>("/uploads/driver-photo/signature");

  if (sizeBytes !== undefined && sizeBytes > ticket.maxBytes) {
    const limitMb = Math.round(ticket.maxBytes / (1024 * 1024));
    throw new Error(`That image is too large. Please choose one under ${limitMb}MB.`);
  }

  const formData = new FormData();
  // The file part is an expo-file-system `File`, NOT React Native's classic
  // { uri, name, type } object.
  //
  // Since SDK 56 Expo installs its own WinterTC-compliant `expo/fetch` as
  // globalThis.fetch. Its multipart encoder accepts strings, Blobs and
  // objects exposing bytes() — and throws "Unsupported FormDataPart
  // implementation" for anything else, which is exactly what the { uri, ... }
  // object is. `File` implements the Blob interface, so it encodes natively
  // and the upload keeps working without opting the whole app out of
  // expo/fetch via EXPO_PUBLIC_USE_RN_FETCH.
  const file = new File(localUri);
  multipart(formData).append("file", file, fileNameFor(localUri, ticket.allowedFormats));

  // Every signed parameter must be sent back EXACTLY as signed, or Cloudinary
  // rejects the upload — which is precisely what stops a tampered request.
  for (const [key, value] of Object.entries(ticket.params)) {
    formData.append(key, String(value));
  }
  formData.append("api_key", ticket.apiKey);
  formData.append("signature", ticket.signature);

  const res = await fetch(ticket.uploadUrl, { method: "POST", body: formData });

  if (!res.ok) {
    throw new Error(`Cloudinary upload failed (${res.status})`);
  }

  const data = (await res.json()) as { secure_url?: string };
  if (!data.secure_url) {
    throw new Error("Cloudinary upload returned no secure_url");
  }
  return data.secure_url;
}
