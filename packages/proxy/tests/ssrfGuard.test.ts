import { BridgeError } from "@https2wss/protocol";
import { describe, expect, it, vi } from "vitest";
import { SsrfGuard } from "../src/security/ssrfGuard.js";

type FakeEntry = { address: string; family: 4 | 6 };

function makeResolver(entries: FakeEntry[]) {
  return vi.fn((_hostname: string) => Promise.resolve(entries));
}

function guard(
  addresses: FakeEntry[],
  allowPrivateNetwork = false,
  overrideResolver?: ReturnType<typeof makeResolver>,
) {
  return new SsrfGuard({
    resolver: overrideResolver ?? makeResolver(addresses),
    allowPrivateNetwork,
  });
}

async function expectDenied(g: SsrfGuard, url: string): Promise<void> {
  await expect(g.assertAllowed(new URL(url))).rejects.toThrow(
    expect.objectContaining({ code: "POLICY_DENIED" }),
  );
}

async function expectAllowed(g: SsrfGuard, url: string): Promise<void> {
  await expect(g.assertAllowed(new URL(url))).resolves.toBeUndefined();
}

describe("SsrfGuard — literal IP bypass (resolver not called)", () => {
  it("denies 127.0.0.1 (loopback v4) without calling resolver", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: false });
    await expectDenied(g, "ws://127.0.0.1:9001");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("denies ::1 (loopback v6) without calling resolver", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: false });
    await expectDenied(g, "ws://[::1]:9001");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("denies 0.0.0.0 (unspecified) without calling resolver", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: false });
    await expectDenied(g, "ws://0.0.0.0:9001");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("allows 8.8.8.8 without calling resolver", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: false });
    await expectAllowed(g, "ws://8.8.8.8:9001");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("allows 2001:4860:4860::8888 (Google DNS v6) without calling resolver", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: false });
    await expectAllowed(g, "ws://[2001:4860:4860::8888]:9001");
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("SsrfGuard — private network blocking", () => {
  it("denies 10.0.0.5 when allowPrivateNetwork is false", async () => {
    const g = guard([{ address: "10.0.0.5", family: 4 }]);
    await expectDenied(g, "ws://internal.example.com:9001");
  });

  it("allows 10.0.0.5 when allowPrivateNetwork is true", async () => {
    const g = guard([{ address: "10.0.0.5", family: 4 }], true);
    await expectAllowed(g, "ws://internal.example.com:9001");
  });

  it("denies 192.168.1.5 when allowPrivateNetwork is false", async () => {
    const g = guard([{ address: "192.168.1.5", family: 4 }]);
    await expectDenied(g, "ws://internal.example.com:9001");
  });

  it("allows 192.168.1.5 when allowPrivateNetwork is true", async () => {
    const g = guard([{ address: "192.168.1.5", family: 4 }], true);
    await expectAllowed(g, "ws://internal.example.com:9001");
  });

  it("denies 172.16.0.1 when allowPrivateNetwork is false", async () => {
    const g = guard([{ address: "172.16.0.1", family: 4 }]);
    await expectDenied(g, "ws://internal.example.com:9001");
  });

  it("denies ULA fc00::1 when allowPrivateNetwork is false", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: false });
    await expectDenied(g, "ws://[fc00::1]:9001");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("allows ULA fc00::1 when allowPrivateNetwork is true", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: true });
    await expectAllowed(g, "ws://[fc00::1]:9001");
  });
});

describe("SsrfGuard — always-denied ranges", () => {
  it("denies 169.254.169.254 (cloud metadata) even with allowPrivateNetwork: true", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: true });
    await expectDenied(g, "ws://169.254.169.254:80");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("denies link-local 169.254.1.1 even with allowPrivateNetwork: true", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: true });
    await expectDenied(g, "ws://169.254.1.1:80");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("denies 127.0.0.1 even with allowPrivateNetwork: true", async () => {
    const resolver = makeResolver([]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: true });
    await expectDenied(g, "ws://127.0.0.1:9001");
  });
});

describe("SsrfGuard — DNS hostname resolution", () => {
  it("allows a hostname resolving to a public IP", async () => {
    const g = guard([{ address: "8.8.8.8", family: 4 }]);
    await expectAllowed(g, "ws://google-dns.example.com:9001");
  });

  it("denies a hostname resolving to a private IP (allowPrivateNetwork: false)", async () => {
    const g = guard([{ address: "10.0.0.1", family: 4 }]);
    await expectDenied(g, "ws://internal.example.com:9001");
  });

  it("DNS rebinding: denies if ANY resolved address is blocked", async () => {
    const resolver = makeResolver([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: false });
    await expectDenied(g, "ws://sneaky.example.com:9001");
  });

  it("calls the resolver for hostname URLs", async () => {
    const resolver = makeResolver([{ address: "8.8.8.8", family: 4 }]);
    const g = new SsrfGuard({ resolver, allowPrivateNetwork: false });
    await g.assertAllowed(new URL("ws://legitimate.example.com:9001"));
    expect(resolver).toHaveBeenCalledWith("legitimate.example.com");
  });
});

describe("SsrfGuard — error structure", () => {
  it("error is a BridgeError with POLICY_DENIED code", async () => {
    const g = guard([{ address: "10.0.0.5", family: 4 }]);
    try {
      await g.assertAllowed(new URL("ws://internal.example.com:9001"));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      const bridgeErr = err as BridgeError;
      expect(bridgeErr.code).toBe("POLICY_DENIED");
      expect(bridgeErr.details).toMatchObject({
        address: "10.0.0.5",
      });
    }
  });
});
