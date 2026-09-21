/**
 * Select the Auth.js cookie prefix from the browser-facing protocol.
 *
 * Traefik terminates TLS before forwarding to the loopback application, so
 * the first X-Forwarded-Proto value is authoritative when it is present.
 */
export function shouldUseSecureSessionCookie({
  forwardedProto,
  requestProtocol,
}: {
  forwardedProto: string | null;
  requestProtocol: string;
}) {
  const publicProtocol = forwardedProto
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();

  return publicProtocol
    ? publicProtocol === "https"
    : requestProtocol === "https:";
}
