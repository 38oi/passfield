"use strict";

const Icons = (() => {
  function svg(name, className = "ico") {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("class", className);
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttributeNS("http://www.w3.org/1999/xlink", "href", `#${name}`);
    use.setAttribute("href", `#${name}`);
    el.append(use);
    return el;
  }

  function html(name, className = "ico") {
    return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="#${name}"></use></svg>`;
  }

  function mount(target, name, className = "ico") {
    if (!target) return null;
    target.replaceChildren(svg(name, className));
    return target;
  }

  return { svg, html, mount };
})();

window.Icons = Icons;
