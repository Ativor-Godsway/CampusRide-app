/*
 * The website's only script: the apps' welcome animation in the hero's phone
 * (a car drives across campus and parks at the Balme Library). It plays once
 * and stays on its last frame, which is the still picture underneath, so the
 * page looks the same without it: without JavaScript, with Reduce Motion or
 * Data Saver on, on phones with little memory, or before it has loaded.
 * lottie-web (MIT) is loaded only when it will play, from this site.
 */
(function () {
  "use strict";

  var box = document.querySelector("[data-welcome]");
  if (!box || !("IntersectionObserver" in window)) return;
  var calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var saveData = navigator.connection && navigator.connection.saveData;
  // As in the apps (WelcomeHero.tsx): phones under 3 GB get the still.
  var lowMemory = navigator.deviceMemory && navigator.deviceMemory < 3;
  if (calm || saveData || lowMemory) return;

  function play() {
    var script = document.createElement("script");
    script.src = "/vendor/lottie_light-5.13.0.min.js";
    script.onload = function () {
      var animation = window.lottie.loadAnimation({
        container: box.querySelector(".phone-anim-art"),
        renderer: "svg",
        loop: false,
        autoplay: false,
        path: box.getAttribute("data-welcome"),
      });
      // Shown (over the still) only once its first frame is drawn.
      animation.addEventListener("DOMLoaded", function () {
        box.classList.add("is-playing");
        animation.play();
      });
    };
    document.head.appendChild(script);
  }

  // Loads once the page itself has (so it never slows the first picture),
  // and only when the phone is on screen.
  function watch() {
    var watcher = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      watcher.disconnect();
      play();
    });
    watcher.observe(box);
  }
  function whenIdle() {
    if ("requestIdleCallback" in window) window.requestIdleCallback(watch, { timeout: 1500 });
    else window.setTimeout(watch, 300);
  }
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
})();
