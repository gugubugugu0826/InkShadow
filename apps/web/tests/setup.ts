import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach } from "vitest";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: webcrypto,
});

Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback): number =>
    window.setTimeout(() => {
      callback(performance.now());
    }, 0),
});

Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: (handle: number): void => {
    window.clearTimeout(handle);
  },
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
