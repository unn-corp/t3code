(async function (operation, input) {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
    );
  };
  const role = (element) =>
    element.getAttribute("role") ||
    {
      BUTTON: "button",
      A: element.hasAttribute("href") ? "link" : null,
      TEXTAREA: "textbox",
      SELECT: "combobox",
      INPUT:
        element.type === "checkbox"
          ? "checkbox"
          : element.type === "radio"
            ? "radio"
            : ["button", "submit"].includes(element.type)
              ? "button"
              : "textbox",
    }[element.tagName] ||
    null;
  const name = (element) =>
    element.getAttribute("aria-label") ||
    (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ")
      .trim() ||
    Array.from(element.labels || [])
      .map((label) => label.textContent)
      .join(" ")
      .trim() ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    (element.tagName === "INPUT" && ["button", "submit"].includes(element.type)
      ? element.value
      : (element.innerText ?? element.textContent ?? "")
    )
      .trim()
      .slice(0, 200);
  const target = () => {
    const locator = input.locator || input.selector;
    if (!locator) return document.activeElement;
    let matches;
    if (locator.startsWith("role=")) {
      const parsed = /^role=([\w-]+)(?:\[name=(?:'([^']*)'|"([^"]*)")\])?$/.exec(locator);
      if (!parsed)
        throw new Error(
          "Phone browser supports role=button[name='Name'], text=Name, snapshot refs, and CSS selectors.",
        );
      matches = Array.from(document.querySelectorAll("*")).filter(
        (element) =>
          role(element) === parsed[1] &&
          ((parsed[2] === undefined && parsed[3] === undefined) ||
            name(element) === (parsed[2] ?? parsed[3])),
      );
    } else if (locator.startsWith("text=")) {
      const text = locator.slice(5).replace(/^(['"])(.*)\1$/, "$2");
      matches = Array.from(document.querySelectorAll("body *")).filter(
        (element) =>
          (element.innerText ?? element.textContent ?? "").trim() === text &&
          !Array.from(element.children).some(
            (child) => (child.innerText ?? child.textContent ?? "").trim() === text,
          ),
      );
    } else if (/^ref=e\d+$/.test(locator)) {
      matches = Array.from(document.querySelectorAll(`[data-t3-phone-ref="${locator.slice(4)}"]`));
    } else matches = Array.from(document.querySelectorAll(locator));
    const shown = matches.filter(visible);
    if (!shown.length) throw new Error("No visible element matches " + locator);
    if (shown.length > 1)
      throw new Error(
        "More than one element matches " + locator + "; use a snapshot ref or specific selector.",
      );
    return shown[0];
  };
  if (operation === "evaluate") {
    if (input.returnByValue === false)
      throw new Error("Phone browser returns values only, not remote JavaScript object handles.");
    const value = (0, eval)(input.expression);
    if (input.awaitPromise === false && value && typeof value.then === "function")
      throw new Error("Use awaitPromise=true to inspect an asynchronous value.");
    return input.awaitPromise === false ? value : await value;
  }
  if (operation === "snapshot") {
    const elements = Array.from(
      document.querySelectorAll(
        'a[href],button,input,textarea,select,[role],[contenteditable="true"],[tabindex]',
      ),
    )
      .filter(visible)
      .slice(0, 250);
    document
      .querySelectorAll("[data-t3-phone-ref]")
      .forEach((element) => element.removeAttribute("data-t3-phone-ref"));
    const interactiveElements = elements.map((element, index) => {
      const ref = `e${index + 1}`;
      element.setAttribute("data-t3-phone-ref", ref);
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: role(element),
        name: name(element),
        selector: `[data-t3-phone-ref="${ref}"]`,
        x: rect.x - (window.visualViewport?.offsetLeft || 0),
        y: rect.y - (window.visualViewport?.offsetTop || 0),
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      url: location.href,
      title: document.title,
      loading: document.readyState !== "complete",
      visibleText: (document.body?.innerText || "").slice(0, 32000),
      interactiveElements,
      accessibilityTree: interactiveElements.map((element, index) => ({
        ref: `e${index + 1}`,
        role: element.role,
        name: element.name,
      })),
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    };
  }
  if (operation === "click") {
    if (typeof input.x === "number" && typeof input.y === "number")
      return { x: input.x, y: input.y };
    const element = target();
    if (element.disabled || element.getAttribute("aria-disabled") === "true")
      throw new Error("Element is disabled");
    element.scrollIntoView({ block: "center", inline: "nearest" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2 - (window.visualViewport?.offsetLeft || 0),
      y: rect.y + rect.height / 2 - (window.visualViewport?.offsetTop || 0),
    };
  }
  if (operation === "type") {
    const element = target();
    if (!element || element.disabled || element.readOnly)
      throw new Error("Choose an editable input");
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(
        element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(element, (input.clear ? "" : element.value) + input.text);
    } else if (element.isContentEditable)
      element.textContent = (input.clear ? "" : element.textContent) + input.text;
    else throw new Error("The target is not editable");
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: input.text }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return {};
  }
  if (operation === "scroll") {
    const element = input.locator || input.selector ? target() : window;
    element.scrollBy({ left: input.deltaX || 0, top: input.deltaY || 0, behavior: "instant" });
    return {};
  }
  if (operation === "waitFor") {
    const deadline = Date.now() + Math.min(60000, input.timeoutMs || 15000);
    do {
      let matches = true;
      if (input.locator || input.selector) {
        try {
          matches = !!target();
        } catch {
          matches = false;
        }
      }
      if (input.text) matches &&= (document.body?.innerText || "").includes(input.text);
      if (input.urlIncludes) matches &&= location.href.includes(input.urlIncludes);
      if (matches) return { url: location.href, title: document.title };
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error("Phone browser wait timed out");
  }
  throw new Error("Unsupported phone browser operation");
});
