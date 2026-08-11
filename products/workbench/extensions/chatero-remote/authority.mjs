const PREFIX = "chatero-remote+";
const TARGET_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,254}[A-Za-z0-9])?$/;
const ENCODED = /^[A-Za-z0-9_-]+$/;

function assertTargetId(value) {
  if (typeof value !== "string" || !TARGET_ID.test(value)) {
    throw new TypeError("remote target id is not a safe opaque identifier");
  }
  return value;
}

export function encodeAuthority(targetId) {
  const encoded = Buffer.from(assertTargetId(targetId), "utf8").toString("base64url");
  return `${PREFIX}${encoded}`;
}

export function decodeAuthority(authority) {
  if (typeof authority !== "string" || !authority.startsWith(PREFIX)) {
    throw new TypeError("invalid Chatero remote authority");
  }
  const encoded = authority.slice(PREFIX.length);
  if (!ENCODED.test(encoded)) {
    throw new TypeError("invalid Chatero remote authority encoding");
  }
  let targetId;
  try {
    targetId = Buffer.from(encoded, "base64url").toString("utf8");
  }
  catch {
    throw new TypeError("invalid Chatero remote authority encoding");
  }
  if (Buffer.from(targetId, "utf8").toString("base64url") !== encoded) {
    throw new TypeError("non-canonical Chatero remote authority");
  }
  try {
    return assertTargetId(targetId);
  }
  catch {
    throw new TypeError("invalid target in Chatero remote authority");
  }
}

export const REMOTE_AUTHORITY_PREFIX = "chatero-remote";
