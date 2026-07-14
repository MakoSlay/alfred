import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  callback(0);
  return 0;
};
