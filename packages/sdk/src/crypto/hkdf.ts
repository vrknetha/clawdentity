const SHA_256_BYTES = 32;

type SubtleCryptoLike = {
  digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
  importKey: (
    format: string,
    keyData: Uint8Array,
    algorithm: unknown,
    extractable: boolean,
    keyUsages: string[],
  ) => Promise<unknown>;
  deriveBits: (
    algorithm: unknown,
    baseKey: unknown,
    length: number,
  ) => Promise<ArrayBuffer>;
  sign: (
    algorithm: unknown,
    key: unknown,
    data: Uint8Array,
  ) => Promise<ArrayBuffer>;
};

function requireCryptoSubtle(): SubtleCryptoLike {
  if (
    typeof crypto === "undefined" ||
    typeof crypto.subtle === "undefined" ||
    crypto.subtle === null
  ) {
    throw new Error("WebCrypto SubtleCrypto is unavailable");
  }

  return crypto.subtle as unknown as SubtleCryptoLike;
}

export async function sha256(input: Uint8Array): Promise<Uint8Array> {
  const subtle = requireCryptoSubtle();
  const digest = await subtle.digest("SHA-256", input);
  return new Uint8Array(digest);
}

export function zeroBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new TypeError("length must be a non-negative integer");
  }
  return new Uint8Array(length);
}

export async function hkdfSha256(input: {
  ikm: Uint8Array;
  salt: Uint8Array;
  info?: Uint8Array;
  length: number;
}): Promise<Uint8Array> {
  if (!Number.isInteger(input.length) || input.length <= 0) {
    throw new TypeError("length must be a positive integer");
  }

  const subtle = requireCryptoSubtle();
  const baseKey = await subtle.importKey("raw", input.ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: input.salt,
      info: input.info ?? new Uint8Array(0),
    },
    baseKey,
    input.length * 8,
  );

  return new Uint8Array(bits);
}

export async function hmacSha256(input: {
  key: Uint8Array;
  data: Uint8Array;
}): Promise<Uint8Array> {
  if (input.key.length !== SHA_256_BYTES) {
    throw new TypeError(`key must be ${SHA_256_BYTES} bytes`);
  }

  const subtle = requireCryptoSubtle();
  const key = await subtle.importKey(
    "raw",
    input.key,
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await subtle.sign("HMAC", key, input.data);
  return new Uint8Array(signature);
}
