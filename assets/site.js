(function () {
  // Everything is visible at rest. Only what starts below the first screen fades in as it arrives.
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var below = Array.prototype.filter.call(document.querySelectorAll('.reveal'), function (el) {
    return el.getBoundingClientRect().top > window.innerHeight;
  });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.remove('pre'); io.unobserve(e.target); } });
  }, {rootMargin: '0px 0px -8% 0px'});
  below.forEach(function (el) { el.classList.add('pre'); io.observe(el); });
})();
