/** DOM helpers, mirroring the product-sdk demo apps. */

export function getEl<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el as T;
}

export function appendLog(
    container: HTMLElement,
    msg: string,
    level: "info" | "ok" | "err" = "info",
): void {
    const line = document.createElement("div");
    line.textContent = msg;
    if (level !== "info") line.className = level;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
}

/** Replace a list's contents with rendered <li> rows. */
export function renderList(list: HTMLElement, rows: HTMLLIElement[]): void {
    list.replaceChildren(...rows);
}

export function li(...children: (Node | string)[]): HTMLLIElement {
    const el = document.createElement("li");
    el.append(...children);
    return el;
}

export function span(className: string, text: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
}
