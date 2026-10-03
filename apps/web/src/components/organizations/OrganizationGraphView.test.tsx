import { OrganizationId, OrganizationRoleId, type Organization } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { OrganizationGraphView } from "./OrganizationGraphView";
import { NODE_WIDTH } from "./organizationGraphLayout";

vi.mock("../ui/button", () => ({ Button: "button" }));

const directorId = OrganizationRoleId.make("director");
const architectId = OrganizationRoleId.make("architect");
const organization: Organization = {
  id: OrganizationId.make("organization"),
  title: "Example",
  mission: "Maintain the repository",
  lifecycle: "draft",
  draftRevision: 1,
  publishedRevision: null,
  directorRoleId: directorId,
  architectRoleId: architectId,
  graph: {
    roles: [
      { id: directorId, kind: "director", title: "Director", mandate: "Coordinate", poolSize: 1 },
      { id: architectId, kind: "architect", title: "Architect", mandate: "Design", poolSize: 1 },
    ],
    edges: [],
  },
  layout: {
    positions: [
      { roleId: directorId, x: 32, y: 32 },
      { roleId: architectId, x: 700, y: 32 },
    ],
  },
  workflows: [],
  bindings: [],
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
};

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function viewport() {
  const transformed = renderer!.root
    .findAllByType("div")
    .find((element) => typeof element.props.style?.transform === "string");
  const transform = transformed?.props.style.transform as string;
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`Invalid graph transform: ${transform}`);
  return { x: Number(match[1]), zoom: Number(match[3]) };
}

it("leaves ordinary wheel scrolling to the page and reveals roles selected from the outline", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const props = {
    organization,
    selectedRoleId: directorId,
    search: "",
    busy: false,
    onSelectRole: vi.fn(),
    onMoveRole: vi.fn(async () => true),
  };
  await act(() => {
    renderer = create(<OrganizationGraphView {...props} />, {
      createNodeMock: (element) => {
        const props = element.props;
        return typeof props === "object" &&
          props !== null &&
          "aria-label" in props &&
          props["aria-label"] === "Organization role graph"
          ? { clientWidth: 320, clientHeight: 288 }
          : null;
      },
    });
  });

  const frame = renderer!.root.findByProps({ "aria-label": "Organization role graph" });
  const before = viewport();
  const preventDefault = vi.fn();
  await act(() => {
    frame.props.onWheel({
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      deltaX: 0,
      deltaY: 80,
      preventDefault,
    });
  });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(viewport()).toEqual(before);

  await act(() =>
    renderer!.update(<OrganizationGraphView {...props} selectedRoleId={architectId} />),
  );
  const selected = viewport();
  expect(selected.x + 700 * selected.zoom).toBeGreaterThanOrEqual(12);
  expect(selected.x + (700 + NODE_WIDTH) * selected.zoom).toBeLessThanOrEqual(308);

  await act(() => renderer!.update(<OrganizationGraphView {...props} />));
  const offscreenRole = renderer!.root
    .findAllByProps({ "data-role-node": true })
    .find((element) => element.props.style.left === 700);
  if (!offscreenRole) throw new Error("Expected the offscreen Architect role");
  await act(() => offscreenRole.props.onFocus());
  const focused = viewport();
  expect(focused.x + 700 * focused.zoom).toBeGreaterThanOrEqual(12);
  expect(focused.x + (700 + NODE_WIDTH) * focused.zoom).toBeLessThanOrEqual(308);
});
