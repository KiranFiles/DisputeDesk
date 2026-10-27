import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function basicAuth(user: string, password: string): RequestHandler {
  const expected = digest(`${user}:${password}`);
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Basic ")) {
      const given = digest(Buffer.from(header.slice(6), "base64").toString("utf8"));
      if (timingSafeEqual(given, expected)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="DisputeDesk", charset="UTF-8"').status(401).send("Authentication required");
  };
}
