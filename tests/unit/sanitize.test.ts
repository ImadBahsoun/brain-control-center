import os from "node:os";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { escapeControls, redact, sanitizeDeep, sanitizedPrefix, sanitizeString } from "@/server/sanitize";
import { GATE_CODE_SENTINEL, GATE_CODE_SENTINEL_2 } from "../helpers/fixture-store";

describe("redact (port of brain-state's patterns)", () => {
  it("masks credentials in URLs", () => {
    expect(redact("see https://user:pw@example.com/x")).toBe("see https://***@example.com/x");
  });
  it("masks Authorization, Bearer, X-API-Key and Cookie headers", () => {
    expect(redact("Authorization: Bearer abcdefgh12345678")).toBe("Authorization: ***");
    expect(redact("token bearer abcdefghijklmnop here")).toBe("token bearer *** here");
    expect(redact("X-API-Key: sekrit123")).toBe("X-API-Key: ***");
    expect(redact("cookie: a=1; b=2\nnext")).toBe("cookie: ***\nnext");
  });
  it("masks --password/--token flags, -u user:pass and Basic auth", () => {
    expect(redact("curl --token abc123 --password=hunter2")).toBe("curl --token=*** --password=***");
    expect(redact("curl -u alice:hunter2 host")).toBe("curl -u *** host");
    expect(redact("Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==")).toBe("Basic ***");
  });
  it("masks well-known token prefixes and JWTs", () => {
    expect(redact("ghp_abcdefghijklmnop and sk_live_123456 and AKIAABCDEFGHIJKLMNOP")).toBe("*** and *** and ***");
    expect(redact("jwt eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4")).toBe("jwt ***");
  });
  it("masks random 40-character AWS-style secrets but not hex SHAs or repetitive ids", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(secret).toHaveLength(40);
    expect(redact(`key ${secret} end`)).toBe("key *** end");
    const sha = "a".repeat(40);
    expect(redact(`tree ${sha}`)).toBe(`tree ${sha}`);
    const hex = "0123456789abcdef0123456789abcdef01234567";
    expect(redact(hex)).toBe(hex); // no upper-case letter: not a candidate
  });
  it("masks PEM blocks with and without END", () => {
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----")).toBe("-----BEGIN RSA PRIVATE KEY-----***-----END RSA PRIVATE KEY-----");
    expect(redact("x -----BEGIN PRIVATE KEY-----\nabc")).toBe("x -----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----");
  });
  it("masks key=value and key: value secret forms, keeping quotes", () => {
    expect(redact("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=***");
    expect(redact('"api_key": "abc"')).toBe('"api_key": "***"');
    expect(redact("secret: 'abc def'")).toBe("secret: '***'");
    expect(redact("MY_TOKEN=\"a b\"")).toBe('MY_TOKEN="***"');
  });
  it("leaves file:line locations alone (password-reset.ts:55)", () => {
    expect(redact("see password-reset.ts:55 and token.ts:7:3")).toBe("see password-reset.ts:55 and token.ts:7:3");
  });
  it("masks -p only for mysql/mariadb/sshpass", () => {
    expect(redact("mysql -u root -p hunter2 db")).toBe("mysql -u root -p *** db");
    expect(redact("grep -p pattern file")).toBe("grep -p pattern file");
  });
  it("masks gate codes after approve but leaves ordinary words", () => {
    expect(redact(`please APPROVE ${GATE_CODE_SENTINEL_2} now`)).toBe("please APPROVE ****** now");
    expect(redact("approve commit")).toBe("approve commit");
    expect(redact("approve ABCDEF")).toBe("approve ABCDEF"); // B is not in the gate alphabet
  });
  it("masks the send command's quoted argument", () => {
    expect(redact("send 'hello secret'")).toBe("send '***'");
  });
  it("masks a gate code after `code` in the protocol's blocked-report form, in any casing and separator", () => {
    expect(redact(`blocked; code ${GATE_CODE_SENTINEL}`)).toBe("blocked; code ******");
    expect(redact(`Blocked: CODE: ${GATE_CODE_SENTINEL_2} (git push)`)).toBe("Blocked: CODE: ****** (git push)");
    expect(redact(`code=${GATE_CODE_SENTINEL} code #${GATE_CODE_SENTINEL_2}`)).toBe("code=****** code #******");
    expect(redact("code ABCDEF")).toBe("code ABCDEF"); // B is not in the gate alphabet
    expect(redact("code review")).toBe("code review");
    expect(redact("encode ABCDEF")).toBe("encode ABCDEF");
  });
});

describe("sanitizeString", () => {
  it("redacts before clipping so a cut-off secret cannot slip through", () => {
    const long = "ghp_" + "a".repeat(100) + " tail";
    const out = sanitizeString(long, 8);
    expect(out).toBe("*** tail");
  });
  it("clips with an ellipsis", () => {
    expect(sanitizeString("abcdefghij", 5)).toBe("abcd…");
  });
  it("masks a secret that straddles the cut: the whole token is gone, not just its tail", () => {
    const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(sanitizeString("x".repeat(181) + " " + aws + " tail", 200)).toBe("x".repeat(181) + " *** tail");
    expect(sanitizeString("a".repeat(475) + "https://admin:S3cretPass@internal.example/x", 500)).not.toContain("S3cret");
    expect(sanitizeString("a".repeat(475) + "https://admin:S3cretPass@internal.example/x", 500)).toContain("https://***@internal");
  });
  it("sanitizedPrefix redacts first and returns a plain prefix", () => {
    expect(sanitizedPrefix("a".repeat(40), 12)).toBe("a".repeat(12));
    expect(sanitizedPrefix("ghp_abcdefghijklmnop", 12)).toBe("***");
    expect(sanitizedPrefix("short", 12)).toBe("short");
  });
  it("bounds redaction cost: a 1 MiB string of PEM markers sanitizes in well under 200 ms", () => {
    const marker = "-----BEGIN A-----";
    const s = marker.repeat(Math.ceil((1024 * 1024) / marker.length)) + "-----END B-----";
    expect(s.length).toBeGreaterThan(1024 * 1024);
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const out = sanitizeString(s);
      best = Math.min(best, performance.now() - t0);
      expect(out.length).toBeLessThanOrEqual(2000);
    }
    expect(best).toBeLessThan(200);
    const t0 = performance.now();
    sanitizeString(marker.repeat(70_000) + " -----END A-----", 500);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it("still masks a pattern that starts just inside the output window of a huge string", () => {
    const secret = "ghp_" + "Z".repeat(30);
    const s = "y".repeat(1989) + " " + secret + " " + "q".repeat(100_000);
    const out = sanitizeString(s);
    expect(out).not.toContain("ghp_Z");
    expect(out.startsWith("y".repeat(1989) + " ***")).toBe(true);
  });
  it("replaces the home directory with ~", () => {
    const home = os.homedir();
    expect(sanitizeString(`${home}/proj/repo`)).toBe("~/proj/repo");
    expect(sanitizeString(home)).toBe("~");
    expect(sanitizeString(`${home}x/other`)).toBe(`${home}x/other`);
  });
  it("escapes C0/C1 controls, line separators and bidi overrides but keeps newline and tab", () => {
    expect(escapeControls("a\u0000b\u001bc\u007fd\u0085e")).toBe("a\\u0000b\\u001bc\\u007fd\\u0085e");
    expect(escapeControls("x y z")).toBe("x\\u2028y\\u2029z");
    expect(escapeControls("l‮r⁦m⁩")).toBe("l\\u202er\\u2066m\\u2069");
    expect(escapeControls("keep\nthis\ttab")).toBe("keep\nthis\ttab");
    expect(sanitizeString("a\rb")).toBe("a\\u000db");
  });
});

describe("sanitizeDeep", () => {
  it("sanitizes every string including keys and nested values", () => {
    const out = sanitizeDeep({ "DB_PASSWORD=x": [{ note: "Bearer abcdefghijkl" }], n: 3, ok: true, nil: null }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["DB_PASSWORD=***", "n", "ok", "nil"]);
    expect(out["DB_PASSWORD=***"]).toEqual([{ note: "Bearer ***" }]);
    expect(out.n).toBe(3);
    expect(out.nil).toBeNull();
  });
  it("nulls values nested deeper than 8 levels", () => {
    let v: unknown = "leaf";
    for (let i = 0; i < 10; i++) v = { v };
    const out = JSON.stringify(sanitizeDeep(v));
    expect(out).not.toContain("leaf");
    expect(out).toContain("null");
  });
});
