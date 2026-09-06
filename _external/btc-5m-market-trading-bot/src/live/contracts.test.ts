import { describe, expect, it } from "vitest";
import {
  CTF_EXCHANGE,
  CTF_EXCHANGE_V1,
  PUSD,
} from "./contracts.js";

describe("contracts (CLOB V2)", () => {
  it("uses V2 exchange address, not V1", () => {
    expect(CTF_EXCHANGE).toBe("0xE111180000d2663C0091e4f400237545B87B996B");
    expect(CTF_EXCHANGE).not.toBe(CTF_EXCHANGE_V1);
  });

  it("defines pUSD collateral token", () => {
    expect(PUSD).toBe("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB");
  });
});
