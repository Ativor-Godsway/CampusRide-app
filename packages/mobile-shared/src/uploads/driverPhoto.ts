import { File, UploadType, type UploadResult, type UploadTask } from "expo-file-system";
import { api } from "../auth/apiClient";

/**
 * Driver profile photo upload — the ONE implementation used by both driver
 * onboarding and the Account screen.
 *
 * The chain, and where each step can fail:
 *
 *   1. The app asks our server for a signed upload ticket
 *      (POST /uploads/driver-photo/signature). The Cloudinary API secret
 *      never leaves the server; the ticket fixes the driver's own public id,
 *      the allowed formats and the stored size.
 *   2. The phone uploads the file STRAIGHT to Cloudinary with that ticket.
 *   3. The caller saves the returned URL on the driver profile, where the
 *      server checks it really is this driver's upload.
 *
 * Every failure is turned into a DriverPhotoError with a `kind`, so screens
 * can say exactly what went wrong instead of "couldn't save".
 */

export type DriverPhotoErrorKind =
  | "no_photo"
  | "permission_denied"
  | "too_large"
  | "wrong_type"
  | "not_configured"
  | "signature_failed"
  | "upload_failed"
  | "network"
  | "session_expired";

export class DriverPhotoError extends Error {
  readonly kind: DriverPhotoErrorKind;
  /** Cloudinary's or the server's own wording, for diagnosis. May be absent. */
  readonly detail?: string;
  /** Size limit in bytes, set on `too_large`. */
  readonly maxBytes?: number;

  constructor(kind: DriverPhotoErrorKind, options: { detail?: string; maxBytes?: number } = {}) {
    super(options.detail ? `${kind}: ${options.detail}` : kind);
    this.name = "DriverPhotoError";
    this.kind = kind;
    this.detail = options.detail;
    this.maxBytes = options.maxBytes;
  }
}

/** What the image picker hands back, reduced to what the upload needs. */
export interface PickedPhoto {
  uri: string;
  fileSize?: number;
  mimeType?: string;
}

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

export interface UploadDriverPhotoOptions {
  /** 0–1 as bytes go out, or null while there is no byte count yet. */
  onProgress?: (fraction: number | null) => void;
}

/** Image types the picker may produce that Cloudinary will take (HEIC is converted to JPG). */
const ACCEPTED_MIME = /^image\/(jpe?g|png|webp|heic|heif)$/i;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function httpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

function serverMessage(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

/** Step 1: ask our server for a signed ticket. */
async function requestTicket(): Promise<UploadTicket> {
  try {
    const { data } = await api.post<UploadTicket>("/uploads/driver-photo/signature");
    return data;
  } catch (error) {
    const status = httpStatus(error);
    if (status === undefined) throw new DriverPhotoError("network");
    if (status === 401) throw new DriverPhotoError("session_expired");
    if (status === 503)
      throw new DriverPhotoError("not_configured", { detail: serverMessage(error) });
    throw new DriverPhotoError("signature_failed", {
      detail: `HTTP ${status}${serverMessage(error) ? `: ${serverMessage(error)}` : ""}`,
    });
  }
}

/** Sorts Cloudinary's rejection message into something a driver can act on. */
function classifyCloudinaryRejection(
  status: number,
  message: string | undefined,
): "upload_failed" | "too_large" | "wrong_type" | "signature_failed" {
  const text = message ?? "";
  if (/file size too large|too large/i.test(text) || status === 413) return "too_large";
  if (/format|invalid image|not allowed/i.test(text)) return "wrong_type";
  // Signature, api_key, stale-timestamp and cloud-name problems are all the
  // server's configuration, not the driver's photo.
  if (/signature|api[_ ]key|stale request|cloud[_ ]name/i.test(text)) return "signature_failed";
  return "upload_failed";
}

/**
 * Tells our server why Cloudinary refused the upload, so the real cause lands
 * in the Render logs (event "driver_photo_upload_failed"). Best effort: a
 * failure to report must never mask the failure being reported.
 */
function reportFailure(
  kind: "upload_failed" | "too_large" | "wrong_type" | "signature_failed",
  status: number,
  message: string | undefined,
) {
  void api.post("/uploads/driver-photo/failure", { kind, status, message }).catch(() => undefined);
}

function parseCloudinaryBody(body: string): { secure_url?: string; error?: { message?: string } } {
  try {
    return JSON.parse(body) as { secure_url?: string; error?: { message?: string } };
  } catch {
    return {};
  }
}

/**
 * Step 2 transport. Prefers expo-file-system's native multipart upload, which
 * streams the file from disk and reports real byte progress. If this Expo
 * runtime's native module predates upload tasks, constructing one throws, and
 * we fall back to fetch + FormData (expo/fetch encodes an expo-file-system
 * `File` part via its bytes()), with no byte count.
 */
async function sendToCloudinary(
  file: File,
  ticket: UploadTicket,
  mimeType: string,
  onProgress: UploadDriverPhotoOptions["onProgress"],
): Promise<UploadResult> {
  // Every signed parameter must go back EXACTLY as signed, or Cloudinary
  // rejects the upload — which is precisely what stops a tampered request.
  const parameters: Record<string, string> = {
    api_key: ticket.apiKey,
    signature: ticket.signature,
  };
  for (const [key, value] of Object.entries(ticket.params)) parameters[key] = String(value);

  let task: UploadTask | null = null;
  try {
    task = file.createUploadTask(ticket.uploadUrl, {
      uploadType: UploadType.MULTIPART,
      fieldName: "file",
      mimeType,
      parameters,
      // Foreground: the driver is watching the progress bar, and iOS
      // background sessions add nothing but restrictions here.
      sessionType: "foreground",
      onProgress: ({ bytesSent, totalBytes }) => {
        if (totalBytes > 0) onProgress?.(Math.min(1, bytesSent / totalBytes));
      },
    });
  } catch {
    task = null;
  }
  if (task) return task.uploadAsync();

  onProgress?.(null);
  const formData = new FormData();
  for (const [key, value] of Object.entries(parameters)) formData.append(key, value);
  // RN's FormData typing predates Blob parts; expo/fetch accepts a File here.
  (formData as unknown as { append(name: string, value: unknown): void }).append("file", file);
  const res = await fetch(ticket.uploadUrl, { method: "POST", body: formData });
  return { status: res.status, body: await res.text(), headers: {} };
}

/**
 * Uploads a picked photo to Cloudinary via a server-signed ticket and returns
 * its `secure_url`. Throws DriverPhotoError on every failure path.
 */
export async function uploadDriverPhoto(
  photo: PickedPhoto | null | undefined,
  { onProgress }: UploadDriverPhotoOptions = {},
): Promise<string> {
  if (!photo?.uri) throw new DriverPhotoError("no_photo");

  if (photo.mimeType && !ACCEPTED_MIME.test(photo.mimeType)) {
    throw new DriverPhotoError("wrong_type", { detail: photo.mimeType });
  }

  const file = new File(photo.uri);
  if (!file.exists) {
    throw new DriverPhotoError("upload_failed", {
      detail: "The picked photo could not be read on this phone",
    });
  }

  onProgress?.(null);
  const ticket = await requestTicket();

  // Fail fast on a huge file — a courtesy, not the security boundary (that is
  // the signed parameters Cloudinary enforces).
  const maxBytes = ticket.maxBytes || DEFAULT_MAX_BYTES;
  const size = photo.fileSize ?? file.size ?? undefined;
  if (size !== undefined && size > maxBytes) {
    throw new DriverPhotoError("too_large", { maxBytes });
  }

  let result: UploadResult;
  try {
    onProgress?.(0);
    result = await sendToCloudinary(file, ticket, photo.mimeType ?? "image/jpeg", onProgress);
  } catch (error) {
    throw new DriverPhotoError("network", {
      detail: error instanceof Error ? error.message : undefined,
    });
  }

  const body = parseCloudinaryBody(result.body);
  if (result.status < 200 || result.status >= 300) {
    const message = body.error?.message;
    const kind = classifyCloudinaryRejection(result.status, message);
    reportFailure(kind, result.status, message);
    throw new DriverPhotoError(kind, {
      detail: `Cloudinary HTTP ${result.status}${message ? `: ${message}` : ""}`,
      maxBytes: kind === "too_large" ? maxBytes : undefined,
    });
  }
  if (!body.secure_url) {
    reportFailure("upload_failed", result.status, "response had no secure_url");
    throw new DriverPhotoError("upload_failed", { detail: "Cloudinary returned no image URL" });
  }

  onProgress?.(1);
  return body.secure_url;
}

export interface FriendlyError {
  title: string;
  message: string;
}

/** Plain-English wording for every DriverPhotoError kind. */
export function describeDriverPhotoError(error: unknown): FriendlyError {
  const kind = error instanceof DriverPhotoError ? error.kind : "upload_failed";
  switch (kind) {
    case "no_photo":
      return {
        title: "Add your photo",
        message:
          "Please add a clear photo of your face. Our team uses it to confirm who you are before approving you.",
      };
    case "permission_denied":
      return {
        title: "Photo access needed",
        message:
          "Allow CampusRide Driver to use your camera or photos in your phone's Settings, then try again.",
      };
    case "too_large": {
      const maxBytes =
        error instanceof DriverPhotoError && error.maxBytes ? error.maxBytes : DEFAULT_MAX_BYTES;
      const mb = Math.round(maxBytes / (1024 * 1024));
      return {
        title: "Photo is too large",
        message: `Please choose a photo under ${mb} MB, or take a new one with the camera.`,
      };
    }
    case "wrong_type":
      return { title: "Unsupported photo type", message: "Please use a JPG, PNG or WebP photo." };
    case "not_configured":
      return {
        title: "Photo uploads are unavailable",
        message: "Photo uploads aren't set up on our server yet. Please try again later.",
      };
    case "signature_failed":
      return {
        title: "Couldn't start the upload",
        message: "Our server couldn't prepare your upload. Please try again in a moment.",
      };
    case "network":
      return {
        title: "Connection problem",
        message:
          "We couldn't reach the server. Check your internet and try again — if the app was idle, the server can take up to a minute to wake up.",
      };
    case "session_expired":
      return {
        title: "Please log in again",
        message: "Your session has ended. Log in again to continue.",
      };
    case "upload_failed":
    default:
      return {
        title: "Upload failed",
        message: "Your photo couldn't be uploaded. Please try again.",
      };
  }
}

/**
 * Plain-English wording for a failed driver profile save (POST or PATCH
 * /driver/profile), distinguishing the causes the old "couldn't save" hid.
 */
export function describeProfileSaveError(error: unknown): FriendlyError {
  const title = "Couldn't save your profile";
  const status = httpStatus(error);
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;

  if (status === undefined)
    return { title, message: describeDriverPhotoError(new DriverPhotoError("network")).message };
  if (code === "INVALID_PHOTO_URL") {
    return {
      title,
      message: "Your photo couldn't be verified. Please upload it again, then save.",
    };
  }
  if (status === 401) return { title, message: "Your session has ended. Please log in again." };
  if (status === 404)
    return {
      title,
      message: "We couldn't find your driver account. Please log out and sign up again.",
    };
  if (status === 400) {
    return {
      title,
      message:
        serverMessage(error) ??
        "Some details are missing or invalid. Please check them and try again.",
    };
  }
  if (status === 429)
    return { title, message: "Too many attempts. Please wait a few minutes and try again." };
  return { title, message: "Something went wrong on our server. Please try again in a moment." };
}
