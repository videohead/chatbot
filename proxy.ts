import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { shouldUseSecureSessionCookie } from "./lib/auth-cookie";
import { logger } from "./lib/logger";

function safeHeaders(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

export async function proxy(request: NextRequest) {
  const startedAt = Date.now();
  const { pathname } = request.nextUrl;

  logger.debug("http.request.start", {
    headers: safeHeaders(request.headers),
    method: request.method,
    pathname,
    search: request.nextUrl.search,
  });

  if (pathname.startsWith("/ping")) {
    logger.debug("http.request.end", {
      durationMs: Date.now() - startedAt,
      method: request.method,
      pathname,
      status: 200,
    });
    return new Response("pong", { status: 200 });
  }

  if (pathname.startsWith("/api/auth")) {
    logger.debug("http.request.pass", {
      durationMs: Date.now() - startedAt,
      method: request.method,
      pathname,
      reason: "auth-route",
    });
    return NextResponse.next();
  }

  // The public app terminates TLS at Traefik while loopback validation uses
  // plain HTTP. Derive the Auth.js cookie name from the request that actually
  // reached this process so both paths can read their own session cookie.
  const secureCookie = shouldUseSecureSessionCookie({
    forwardedProto: request.headers.get("x-forwarded-proto"),
    requestProtocol: request.nextUrl.protocol,
  });

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie,
  });

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  if (["/login", "/register"].includes(pathname)) {
    if (token?.type === "regular") {
      logger.info("http.request.redirect", {
        durationMs: Date.now() - startedAt,
        method: request.method,
        pathname,
        reason: "authenticated-user",
        status: 307,
      });
      return NextResponse.redirect(new URL(`${base}/`, request.url));
    }

    logger.debug("http.request.pass", {
      durationMs: Date.now() - startedAt,
      method: request.method,
      pathname,
      reason: "public-auth-page",
    });
    return NextResponse.next();
  }

  if (token?.type !== "regular") {
    const redirectUrl = encodeURIComponent(new URL(request.url).pathname);

    logger.info("http.request.redirect", {
      durationMs: Date.now() - startedAt,
      method: request.method,
      pathname,
      reason: "unauthenticated",
      status: 307,
    });

    return NextResponse.redirect(
      new URL(`${base}/login?redirectUrl=${redirectUrl}`, request.url)
    );
  }

  logger.debug("http.request.pass", {
    durationMs: Date.now() - startedAt,
    method: request.method,
    pathname,
    reason: "authorized",
  });

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
