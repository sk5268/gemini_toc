let tocObserver = null;
let currentQueryCount = 0;

const CONSTANTS = {
  SELECTORS: {
    USER_MESSAGE: ".query-text-line, .user-message, .query",
    SUBMIT_BUTTON: '[data-testid="submit-button"], button[type="submit"]',
    ASK_INPUT: "textarea, #ask-input",
    CHAT_CONTAINER: "main, [role='main']",
  },
  IDS: {
    TOC_CONTAINER: "gemini-toc-extension",
    TOC_TOGGLE_BTN: "toc-toggle-btn",
    SEARCH_INPUT: "toc-search-input",
    SEARCH_CLEAR: "toc-search-clear",
  },
  CLASSES: {
    TOC_HEADER: "toc-header",
    TOC_HEADER_CONTENT: "toc-header-content",
    TOC_DRAG_HANDLE: "toc-drag-handle",
    TOC_SEARCH_CONTAINER: "toc-search-container",
    COLLAPSED: "collapsed",
  },
  DELAYS: {
    PAGE_LOAD: 1500,
    PROMPT_SUBMISSION: 500,
    STATE_CHECK: 1000,
  },
  CONSTRAINTS: {
    PADDING: 10,
    MAX_QUERY_LENGTH: 70,
    TRUNCATE_SUFFIX: "...",
    COLLAPSE_BREAKPOINT: 1024,
  },
  STORAGE_KEY: "gemini-toc-position",
};

/**
 * Manages TOC positioning and persistence
 */
class PositionManager {
  static savePosition(x, y) {
    localStorage.setItem(CONSTANTS.STORAGE_KEY, JSON.stringify({ x, y }));
  }

  static getSavedPosition() {
    const saved = localStorage.getItem(CONSTANTS.STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  }

  static applyPosition(element, x, y) {
    const styles = {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      right: "auto",
      bottom: "auto",
      margin: "0",
      transform: "none",
    };

    Object.entries(styles).forEach(([prop, value]) => {
      element.style.setProperty(prop, value, "important");
    });
  }

  static constrainToViewport(x, y, elementWidth, elementHeight) {
    const padding = CONSTANTS.CONSTRAINTS.PADDING;
    const minX = padding;
    const minY = padding;
    const maxX = window.innerWidth - elementWidth - padding;
    const maxY = window.innerHeight - elementHeight - padding;

    return {
      x: Math.max(minX, Math.min(x, maxX)),
      y: Math.max(minY, Math.min(y, maxY)),
    };
  }
}

/**
 * Handles drag functionality for the TOC
 */
class DragManager {
  constructor(element, positionManager) {
    this.element = element;
    this.positionManager = positionManager;
    this.isDragging = false;
    this.startMouseX = 0;
    this.startMouseY = 0;
    this.startElementX = 0;
    this.startElementY = 0;

    this.init();
  }

  init() {
    const header = this.element.querySelector(
      `.${CONSTANTS.CLASSES.TOC_HEADER}`,
    );
    if (!header) return;

    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.addEventListener("mousedown", this.startDrag.bind(this));
  }

  startDrag(e) {
    if (e.target.closest(`#${CONSTANTS.IDS.TOC_TOGGLE_BTN}`)) return;

    e.preventDefault();
    e.stopPropagation();

    this.isDragging = true;
    this.startMouseX = e.clientX;
    this.startMouseY = e.clientY;

    const rect = this.element.getBoundingClientRect();
    this.startElementX = rect.left;
    this.startElementY = rect.top;

    this.positionManager.applyPosition(
      this.element,
      this.startElementX,
      this.startElementY,
    );
    this.applyDragStyles();

    document.addEventListener("mousemove", this.drag.bind(this));
    document.addEventListener("mouseup", this.stopDrag.bind(this));
    document.body.style.userSelect = "none";
  }

  drag(e) {
    if (!this.isDragging) return;

    e.preventDefault();
    e.stopPropagation();

    const deltaX = e.clientX - this.startMouseX;
    const deltaY = e.clientY - this.startMouseY;

    let newX = this.startElementX + deltaX;
    let newY = this.startElementY + deltaY;

    const constrained = this.positionManager.constrainToViewport(
      newX,
      newY,
      this.element.offsetWidth,
      this.element.offsetHeight,
    );

    this.positionManager.applyPosition(
      this.element,
      constrained.x,
      constrained.y,
    );
  }

  stopDrag() {
    if (!this.isDragging) return;

    this.isDragging = false;

    const rect = this.element.getBoundingClientRect();
    this.positionManager.savePosition(rect.left, rect.top);

    this.removeDragStyles();
    document.removeEventListener("mousemove", this.drag.bind(this));
    document.removeEventListener("mouseup", this.stopDrag.bind(this));
    document.body.style.userSelect = "";
  }

  applyDragStyles() {
    this.element.style.opacity = "0.8";
    this.element.style.transition = "none";
    this.element.style.zIndex = "10001";
  }

  removeDragStyles() {
    this.element.style.opacity = "";
    this.element.style.transition = "";
    this.element.style.zIndex = "10000";
  }
}

function extractAllQueries() {
  /**
   * Improved strategy:
   * 1. Prefer container-level elements (.user-message, .query). Each container becomes one query.
   *    Inside a container, concatenate all descendant `.query-text-line` nodes (fallback to container text).
   * 2. If no such containers exist (site variant), fallback to grouping consecutive `.query-text-line`
   *    siblings that share the SAME parent (prevents merging across different queries).
   * 3. Filter greetings, dedupe (case-insensitive), and return [{ text, elements:[anchorElement] }].
   */
  const containerSelector = ".user-message, .query";
  const containers = Array.from(document.querySelectorAll(containerSelector));

  const groups = [];

  if (containers.length) {
    containers.forEach((container) => {
      const lineNodes = Array.from(
        container.querySelectorAll(".query-text-line"),
      );
      let text;
      if (lineNodes.length) {
        text = lineNodes
          .map((n) => n.textContent)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        text = container.textContent.replace(/\s+/g, " ").trim();
      }
      if (!text) return;
      groups.push({ text, elements: [container] });
    });
  } else {
    // Fallback: line grouping limited to siblings with same parent
    const nodes = Array.from(
      document.querySelectorAll(CONSTANTS.SELECTORS.USER_MESSAGE),
    );
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const isLine = el.classList && el.classList.contains("query-text-line");

      if (isLine) {
        const prev = el.previousElementSibling;
        if (
          prev &&
          prev.parentElement === el.parentElement &&
          prev.classList.contains("query-text-line")
        ) {
          // Middle of a block handled by its first line
          continue;
        }

        const parts = [el.textContent];
        let j = i + 1;
        while (
          j < nodes.length &&
          nodes[j].classList &&
          nodes[j].classList.contains("query-text-line") &&
          nodes[j].parentElement === el.parentElement
        ) {
          parts.push(nodes[j].textContent);
          j++;
        }
        i = j - 1;
        const text = parts.join(" ").replace(/\s+/g, " ").trim();
        if (text) groups.push({ text, elements: [el] });
      } else {
        const text = el.textContent.replace(/\s+/g, " ").trim();
        if (text) groups.push({ text, elements: [el] });
      }
    }
  }

  // Filter greetings & dedupe
  const seen = new Set();
  return groups.filter((g) => {
    const lower = g.text.toLowerCase();
    if (lower.startsWith("hello,")) return false;
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

function createTOC(shouldScrollToBottom = false) {
  const existingTOC = document.getElementById(CONSTANTS.IDS.TOC_CONTAINER);
  if (existingTOC) {
    existingTOC.remove();
  }

  let questions = extractAllQueries();
  currentQueryCount = questions.length;

  if (questions.length < 1) {
    return;
  }

  const tocContainer = document.createElement("div");
  tocContainer.id = CONSTANTS.IDS.TOC_CONTAINER;

  const tocHeader = document.createElement("div");
  tocHeader.className = CONSTANTS.CLASSES.TOC_HEADER;

  const headerContent = document.createElement("div");
  headerContent.className = CONSTANTS.CLASSES.TOC_HEADER_CONTENT;

  const dragHandle = document.createElement("div");
  dragHandle.className = CONSTANTS.CLASSES.TOC_DRAG_HANDLE;
  dragHandle.title = "Drag to move";

  const title = document.createElement("h2");
  title.textContent = "Table of Contents";

  const toggleButton = document.createElement("button");
  toggleButton.id = CONSTANTS.IDS.TOC_TOGGLE_BTN;
  toggleButton.title = "Toggle Table of Contents";

  headerContent.appendChild(dragHandle);
  headerContent.appendChild(title);
  tocHeader.appendChild(headerContent);
  tocHeader.appendChild(toggleButton);

  const searchContainer = document.createElement("div");
  searchContainer.className = CONSTANTS.CLASSES.TOC_SEARCH_CONTAINER;

  const searchInputElement = document.createElement("input");
  searchInputElement.type = "text";
  searchInputElement.id = CONSTANTS.IDS.SEARCH_INPUT;
  searchInputElement.placeholder = "Search queries...";

  const searchClearElement = document.createElement("div");
  searchClearElement.id = CONSTANTS.IDS.SEARCH_CLEAR;
  searchClearElement.title = "Clear search";
  searchClearElement.textContent = "×";

  searchContainer.appendChild(searchInputElement);
  searchContainer.appendChild(searchClearElement);

  const tocList = document.createElement("ul");

  tocContainer.appendChild(tocHeader);
  tocContainer.appendChild(searchContainer);
  tocContainer.appendChild(tocList);

  toggleButton.addEventListener("click", () => {
    tocContainer.classList.toggle(CONSTANTS.CLASSES.COLLAPSED);
  });

  const allListItems = [];

  const updateSearchResults = () => {
    const searchTerm = searchInputElement.value.toLowerCase().trim();
    allListItems.forEach((item) => {
      const text = item.querySelector("a").textContent.toLowerCase();
      item.style.display = text.includes(searchTerm) ? "block" : "none";
    });
  };

  searchInputElement.addEventListener("input", updateSearchResults);
  searchClearElement.addEventListener("click", () => {
    searchInputElement.value = "";
    updateSearchResults();
    searchInputElement.focus();
  });
  searchInputElement.addEventListener("input", () => {
    searchClearElement.style.display = searchInputElement.value
      ? "flex"
      : "none";
  });

  if (window.innerWidth <= CONSTANTS.CONSTRAINTS.COLLAPSE_BREAKPOINT) {
    tocContainer.classList.add(CONSTANTS.CLASSES.COLLAPSED);
  }

  questions.forEach((group, index) => {
    const questionText = group.text;
    const shortText =
      questionText.length > CONSTANTS.CONSTRAINTS.MAX_QUERY_LENGTH
        ? questionText.substring(
            0,
            CONSTANTS.CONSTRAINTS.MAX_QUERY_LENGTH - 3,
          ) + CONSTANTS.CONSTRAINTS.TRUNCATE_SUFFIX
        : questionText;
    const questionId = `toc-question-${index}`;

    const anchorEl = group.elements[0];
    if (anchorEl) {
      anchorEl.id = questionId;
    }

    const listItem = document.createElement("li");
    const link = document.createElement("a");
    link.href = `#${questionId}`;
    link.textContent = `${index + 1}. ${shortText}`;
    link.title = questionText;

    link.addEventListener("click", (e) => {
      e.preventDefault();
      const targetElement = document.getElementById(questionId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });

    listItem.appendChild(link);
    tocList.appendChild(listItem);
    allListItems.push(listItem);
  });

  new DragManager(tocContainer, PositionManager);

  const savedPosition = PositionManager.getSavedPosition();
  if (savedPosition) {
    PositionManager.applyPosition(
      tocContainer,
      savedPosition.x,
      savedPosition.y,
    );
  } else {
    tocContainer.style.top = "30px";
    tocContainer.style.right = "20px";
  }

  if (shouldScrollToBottom) {
    requestAnimationFrame(() => {
      tocList.scrollTop = tocList.scrollHeight;
    });
  }

  tocContainer.style.position = "fixed";
  tocContainer.style.zIndex = "10000";
  document.body.appendChild(tocContainer);

  // After creating the TOC, set up an observer for real-time updates.
  setupTocObserver();
}

function refreshTOC(event) {
  const isInteraction =
    event && (event.type === "click" || event.type === "keydown");
  const delay = isInteraction
    ? CONSTANTS.DELAYS.PROMPT_SUBMISSION
    : CONSTANTS.DELAYS.PAGE_LOAD;

  setTimeout(() => {
    const newQueryCount = extractAllQueries().length;
    // Only update if the number of queries has changed.
    if (newQueryCount !== currentQueryCount) {
      createTOC(isInteraction);
    }
  }, delay);
}

function setupTocObserver() {
  if (tocObserver) tocObserver.disconnect();

  const chatContainer = document.querySelector(
    CONSTANTS.SELECTORS.CHAT_CONTAINER,
  );
  if (!chatContainer) return;

  tocObserver = new MutationObserver(() => {
    const newQueryCount = extractAllQueries().length;
    if (newQueryCount > currentQueryCount) {
      // A new prompt was added in the current chat, refresh TOC
      createTOC(true);
    }
  });

  tocObserver.observe(chatContainer, { childList: true, subtree: true });
}

function initialize() {
  // Disconnect any previous observer to avoid duplicates
  if (tocObserver) tocObserver.disconnect();
  createTOC(false);
}

// --- Event Listeners & Initializers ---

// Initial setup on page load
window.addEventListener("load", initialize);

// For SPA navigations or back/forward button usage
window.addEventListener("pageshow", initialize);

// Listen for clicks on the submit button
document.addEventListener(
  "click",
  (e) => {
    if (e.target.closest(CONSTANTS.SELECTORS.SUBMIT_BUTTON)) {
      refreshTOC(e);
    }
  },
  true,
);

// Listen for Enter key in the input area
document.addEventListener(
  "keydown",
  (e) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      document.activeElement.matches(CONSTANTS.SELECTORS.ASK_INPUT)
    ) {
      refreshTOC(e);
    }
  },
  true,
);

// Keep TOC in viewport on resize
window.addEventListener("resize", () => {
  const tocContainer = document.getElementById(CONSTANTS.IDS.TOC_CONTAINER);
  if (!tocContainer) return;

  const rect = tocContainer.getBoundingClientRect();
  const constrained = PositionManager.constrainToViewport(
    rect.left,
    rect.top,
    tocContainer.offsetWidth,
    tocContainer.offsetHeight,
  );

  if (constrained.x !== rect.left || constrained.y !== rect.top) {
    PositionManager.applyPosition(tocContainer, constrained.x, constrained.y);
    PositionManager.savePosition(constrained.x, constrained.y);
  }
});

// This is the main loop to ensure TOC exists if it should.
setInterval(() => {
  const tocExists = document.getElementById(CONSTANTS.IDS.TOC_CONTAINER);
  const queriesExist = document.querySelector(CONSTANTS.SELECTORS.USER_MESSAGE);

  // If queries are on the page but the TOC is missing, it means we are in a new
  // chat window or a page refresh occurred. Initialize the TOC.
  if (queriesExist && !tocExists) {
    initialize();
  }
}, CONSTANTS.DELAYS.STATE_CHECK);
