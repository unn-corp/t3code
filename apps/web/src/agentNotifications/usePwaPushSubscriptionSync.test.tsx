import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { usePwaPushSubscriptionSync } from "./usePwaPushSubscriptionSync";

const { getSubscription } = vi.hoisted(() => ({ getSubscription: vi.fn() }));
vi.mock("./browserNotifications", () => ({
  getExistingBrowserPushSubscription: getSubscription,
}));

let renderer: ReactTestRenderer;
const onSubscription = vi.fn();
const onMissingSubscription = vi.fn();

function Probe({ enabled = true }: { enabled?: boolean }) {
  usePwaPushSubscriptionSync({ enabled, onSubscription, onMissingSubscription });
  return null;
}

beforeEach(() => {
  getSubscription.mockReset().mockResolvedValue(null);
  onSubscription.mockReset().mockResolvedValue(undefined);
  onMissingSubscription.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("repairs enabled settings when the browser subscription has disappeared", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(onMissingSubscription).toHaveBeenCalledOnce();
  expect(onSubscription).not.toHaveBeenCalled();
});

it("synchronizes an existing subscription without disabling it", async () => {
  const subscription = { endpoint: "https://push.example/device" };
  getSubscription.mockResolvedValue(subscription);
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(onSubscription).toHaveBeenCalledWith(subscription);
  expect(onMissingSubscription).not.toHaveBeenCalled();
});

it("keeps enabled settings when checking the browser subscription fails", async () => {
  getSubscription.mockRejectedValue(new Error("temporarily unavailable"));
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(onMissingSubscription).not.toHaveBeenCalled();
  expect(onSubscription).not.toHaveBeenCalled();
});

it("does not synchronize a subscription while notifications are disabled", async () => {
  await act(async () => {
    renderer = create(<Probe enabled={false} />);
  });
  expect(getSubscription).not.toHaveBeenCalled();
});

it.each(["unmount", "disable"])("ignores a stale subscription check after %s", async (action) => {
  let resolve: (value: null) => void = () => {};
  getSubscription.mockReturnValue(
    new Promise<null>((done) => {
      resolve = done;
    }),
  );
  await act(async () => {
    renderer = create(<Probe />);
  });
  act(() => {
    if (action === "unmount") renderer.unmount();
    else renderer.update(<Probe enabled={false} />);
  });
  await act(async () => {
    resolve(null);
  });
  expect(onMissingSubscription).not.toHaveBeenCalled();
  expect(onSubscription).not.toHaveBeenCalled();
});
