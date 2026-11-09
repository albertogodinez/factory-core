// WebDriver sync script body. arguments[0]: comma-separated CSS selectors (default: every overflowing scroller).
// Returns which scrollbar properties Safari supports and, per element, what it computed.
const sel = arguments[0];
const els = sel
  ? sel.split(',').flatMap((s) => [...document.querySelectorAll(s.trim())])
  : [...document.querySelectorAll('*')].filter((el) => {
      const cs = getComputedStyle(el);
      return (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) ||
        (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth);
    });
const name = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join('')}`;
return {
  supports: {
    scrollbarWidth: CSS.supports('scrollbar-width', 'thin'),
    scrollbarColor: CSS.supports('scrollbar-color', 'gray transparent'),
  },
  scrollers: els.map((el) => {
    const cs = getComputedStyle(el);
    return {
      el: name(el),
      scrollbarWidth: cs.scrollbarWidth,
      scrollbarColor: cs.scrollbarColor,
      webkitScrollbarWidth: getComputedStyle(el, '::-webkit-scrollbar').width,
      gutterY: el.offsetWidth - el.clientWidth - (parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)),
    };
  }),
};
