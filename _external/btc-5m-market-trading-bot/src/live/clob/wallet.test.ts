import { SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { describe, expect, it } from "vitest";
import { signatureTypeLabel } from "./wallet.js";

describe("signatureTypeLabel", () => {
  it("maps known types", () => {
    expect(signatureTypeLabel(SignatureTypeV2.EOA)).toContain("EOA");
    expect(signatureTypeLabel(SignatureTypeV2.POLY_GNOSIS_SAFE)).toContain("GNOSIS");
    expect(signatureTypeLabel(SignatureTypeV2.POLY_1271)).toContain("1271");
  });
});
