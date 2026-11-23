import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ConnectionForm,
  defaultConnectionSecret,
  emptyConnection,
  secretAfterUrlPaste,
} from "@/features/connections";

describe("connection password defaults and form state", () => {
  it("defaults new connections to OS keychain on desktop and prompt in browser mode", () => {
    expect(defaultConnectionSecret(false)).toBe("keychain");
    expect(defaultConnectionSecret(true)).toBe("prompt");
  });

  it("preserves secret when pasted URL has no password and chooses keychain on desktop when it does", () => {
    expect(secretAfterUrlPaste("env:PG_PASSWORD", null, false)).toBe("env:PG_PASSWORD");
    expect(secretAfterUrlPaste("prompt", null, false)).toBe("prompt");
    expect(secretAfterUrlPaste("keychain", null, false)).toBe("keychain");

    expect(secretAfterUrlPaste("prompt", "secret", false)).toBe("keychain");
    expect(secretAfterUrlPaste("keychain", "secret", false)).toBe("keychain");
    expect(secretAfterUrlPaste("env:PG_PASSWORD", "secret", false)).toBe("keychain");
    expect(secretAfterUrlPaste("keychain", "secret", true)).toBe("prompt");
  });

  it("renders keychain and prompt password fields with distinct persistence cues", () => {
    const newKeychain = renderToStaticMarkup(
      <ConnectionForm
        initial={{ ...emptyConnection, id: null, secret: "keychain" }}
        onSave={() => {}}
      />,
    );
    expect(newKeychain).toContain('placeholder="Saved in OS keychain"');
    expect(newKeychain).toContain('id="connection-password"');
    expect(newKeychain).toMatch(/id="connection-password"[^>]*required=""/);

    const existingKeychain = renderToStaticMarkup(
      <ConnectionForm
        initial={{ ...emptyConnection, id: "conn-1", secret: "keychain" }}
        onSave={() => {}}
      />,
    );
    expect(existingKeychain).toContain('placeholder="Keep saved password"');
    expect(existingKeychain).not.toMatch(/id="connection-password"[^>]*required=""/);

    const promptMode = renderToStaticMarkup(
      <ConnectionForm
        initial={{ ...emptyConnection, id: null, secret: "prompt" }}
        onSave={() => {}}
      />,
    );
    expect(promptMode).toContain("Password (session only)");
    expect(promptMode).toContain('placeholder="Not saved — for this session"');
    expect(promptMode).not.toMatch(/id="connection-password"[^>]*required=""/);
  });
});
