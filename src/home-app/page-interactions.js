import React from "react";

function elements(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function listen(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

function setActive(items, activeIndex, markCurrent = false) {
  items.forEach((item, index) => {
    item.classList.toggle("active", index === activeIndex);
    if (!markCurrent) return;
    if (index === activeIndex) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  });
}

function setupHeroCarousel() {
  const slides = elements(".carousel-slide");
  const dots = elements(".carousel-dot");
  const previous = document.querySelector(".carousel-prev");
  const next = document.querySelector(".carousel-next");
  const hero = document.querySelector(".hero");
  if (!hero || slides.length === 0) return () => {};

  let current = Math.max(0, slides.findIndex((slide) => slide.classList.contains("active")));
  let touchStartX = 0;
  let intervalId = 0;
  const cleanups = [];

  function show(index) {
    if (index >= slides.length) current = 0;
    else if (index < 0) current = slides.length - 1;
    else current = index;
    setActive(slides, current);
    setActive(dots, current, true);
  }
  function goNext() {
    show(current + 1);
  }
  function goPrevious() {
    show(current - 1);
  }
  function startAutoSlide() {
    window.clearInterval(intervalId);
    intervalId = window.setInterval(goNext, 5000);
  }
  function handleTouchEnd(event) {
    const touchEndX = event.changedTouches[0]?.screenX || 0;
    const delta = touchStartX - touchEndX;
    if (Math.abs(delta) > 50) (delta > 0 ? goNext : goPrevious)();
  }

  cleanups.push(listen(previous, "click", goPrevious));
  cleanups.push(listen(next, "click", goNext));
  dots.forEach((dot, index) => cleanups.push(listen(dot, "click", () => show(index))));
  cleanups.push(listen(hero, "touchstart", (event) => {
    touchStartX = event.changedTouches[0]?.screenX || 0;
  }, { passive: true }));
  cleanups.push(listen(hero, "touchend", handleTouchEnd, { passive: true }));
  cleanups.push(listen(hero, "mouseenter", () => window.clearInterval(intervalId)));
  cleanups.push(listen(hero, "mouseleave", startAutoSlide));

  show(current);
  startAutoSlide();
  return () => {
    window.clearInterval(intervalId);
    cleanups.forEach((cleanup) => cleanup());
  };
}

function setupSlidingCarousel({
  trackSelector,
  slideSelector,
  indicatorSelector,
  previousSelector,
  nextSelector,
  touchSelector,
  syncHeight = false,
}) {
  const track = document.querySelector(trackSelector);
  const slides = elements(slideSelector);
  const indicators = elements(indicatorSelector);
  const previous = elements(previousSelector);
  const next = elements(nextSelector);
  const touchTarget = document.querySelector(touchSelector);
  if (!track || slides.length === 0) return () => {};

  let current = 0;
  let touchStartX = 0;
  const cleanups = [];

  function setHeight() {
    if (!syncHeight || !touchTarget) return;
    const active = slides[current];
    if (active) touchTarget.style.height = `${active.scrollHeight}px`;
  }
  function update() {
    track.style.transform = `translateX(-${current * 100}%)`;
    setActive(indicators, current, true);
    previous.forEach((button) => { button.disabled = current === 0; });
    next.forEach((button) => { button.disabled = current === slides.length - 1; });
    setHeight();
  }
  function go(index) {
    current = Math.max(0, Math.min(index, slides.length - 1));
    update();
  }
  function handleTouchEnd(event) {
    const touchEndX = event.changedTouches[0]?.screenX || 0;
    const delta = touchStartX - touchEndX;
    if (Math.abs(delta) > 50) go(current + (delta > 0 ? 1 : -1));
  }

  previous.forEach((button) => cleanups.push(listen(button, "click", () => go(current - 1))));
  next.forEach((button) => cleanups.push(listen(button, "click", () => go(current + 1))));
  indicators.forEach((indicator) => cleanups.push(listen(indicator, "click", () => {
    const index = Number.parseInt(indicator.getAttribute("data-slide") || "", 10);
    if (!Number.isNaN(index)) go(index);
  })));
  cleanups.push(listen(touchTarget, "touchstart", (event) => {
    touchStartX = event.changedTouches[0]?.screenX || 0;
  }, { passive: true }));
  cleanups.push(listen(touchTarget, "touchend", handleTouchEnd, { passive: true }));
  if (syncHeight) cleanups.push(listen(window, "resize", setHeight));

  update();
  return () => cleanups.forEach((cleanup) => cleanup());
}

function setupRevealObserver() {
  const observed = [
    ...elements(".event-item").map((item, index) => ({ item, delay: index * 150 })),
    ...elements(".stat-card").map((item, index) => ({ item, delay: index * 100 })),
    ...elements(".perk").map((item, index) => ({ item, delay: index * 100 })),
    ...elements(".contact-box").map((item, index) => ({ item, delay: index * 150 })),
    ...elements(".fade-in, .section-title").map((item) => ({ item, delay: Number(item.dataset.delay || 0) })),
  ];
  if (observed.length === 0) return () => {};
  if (!("IntersectionObserver" in window)) {
    observed.forEach(({ item }) => item.classList.add("visible"));
    return () => {};
  }

  const timeouts = new Set();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const timeoutId = window.setTimeout(() => {
        entry.target.classList.add("visible");
        timeouts.delete(timeoutId);
      }, Number(entry.target.dataset.delay || 0));
      timeouts.add(timeoutId);
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.1, rootMargin: "0px 0px -50px 0px" });

  observed.forEach(({ item, delay }) => {
    item.dataset.delay = String(delay);
    observer.observe(item);
  });

  return () => {
    observer.disconnect();
    timeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
  };
}

function setupStatCounters() {
  const cards = elements(".stat-card");
  if (cards.length === 0) return () => {};

  const frames = new Set();
  let fallbackId = 0;
  let observer = null;

  function animateCounter(el) {
    if (!el || el.dataset.animated === "true") return;
    const target = Number.parseInt(el.dataset.count || "", 10);
    if (Number.isNaN(target)) return;
    el.dataset.animated = "true";
    const duration = 2000;
    const started = performance.now();
    function update(now) {
      const progress = Math.min((now - started) / duration, 1);
      el.textContent = String(Math.floor(progress * target));
      if (progress < 1) {
        const frameId = window.requestAnimationFrame(update);
        frames.add(frameId);
      } else {
        el.textContent = String(target);
      }
    }
    const frameId = window.requestAnimationFrame(update);
    frames.add(frameId);
  }
  function animateCard(card) {
    animateCounter(card.querySelector(".stat-number"));
  }

  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          animateCard(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.3 });
    cards.forEach((card) => observer.observe(card));
  } else {
    cards.forEach(animateCard);
  }

  fallbackId = window.setTimeout(() => {
    cards.forEach((card) => {
      const rect = card.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) animateCard(card);
    });
  }, 500);

  return () => {
    if (observer) observer.disconnect();
    window.clearTimeout(fallbackId);
    frames.forEach((frameId) => window.cancelAnimationFrame(frameId));
  };
}

function setupSmoothAnchors() {
  function handleClick(event) {
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!link) return;
    const hash = link.getAttribute("href") || "";
    if (hash === "#") {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const target = document.querySelector(hash);
    if (!target) return;
    event.preventDefault();
    const offset = 80;
    const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
    window.scrollTo({ top, behavior: "smooth" });
  }

  return listen(document, "click", handleClick);
}

function setupDoubleTapGuard() {
  let lastTap = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  function handleTouchEnd(event) {
    const now = Date.now();
    const elapsed = now - lastTap;
    const touch = event.changedTouches[0];
    const x = touch?.clientX || 0;
    const y = touch?.clientY || 0;
    const distance = Math.hypot(x - lastTapX, y - lastTapY);
    if (elapsed < 500 && elapsed > 0 && distance < 24) event.preventDefault();
    lastTap = now;
    lastTapX = x;
    lastTapY = y;
  }
  return listen(document, "touchend", handleTouchEnd);
}

export function HomePageInteractions() {
  React.useEffect(() => {
    const cleanups = [
      setupHeroCarousel(),
      setupSlidingCarousel({
        trackSelector: ".about-carousel",
        slideSelector: ".carousel-slide-about",
        indicatorSelector: ".about-carousel-nav .carousel-indicator",
        previousSelector: "#aboutPrevBtn",
        nextSelector: "#aboutNextBtn",
        touchSelector: ".about-carousel-container",
      }),
      setupSlidingCarousel({
        trackSelector: ".courses-carousel",
        slideSelector: ".carousel-slide-courses",
        indicatorSelector: ".courses-carousel-nav .carousel-indicator",
        previousSelector: "#coursesPrevBtn, #courses .slide-nav-prev",
        nextSelector: "#coursesNextBtn, #courses .slide-nav-next",
        touchSelector: ".courses-carousel-container",
        syncHeight: true,
      }),
      setupRevealObserver(),
      setupStatCounters(),
      setupSmoothAnchors(),
      setupDoubleTapGuard(),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  return null;
}
