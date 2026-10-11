// Second layer of notification blocking. Registered for the MAIN world only while a session runs.
(() => {
  if (window.__focusUpNotifications) return;
  window.__focusUpNotifications = true;

  const Fake = function Notification(title) {
    const n = new EventTarget();
    n.title = title;
    n.close = () => {};
    return n;
  };
  Object.defineProperty(Fake, 'permission', { get: () => 'denied' });
  Fake.maxActions = 0;
  Fake.requestPermission = cb => {
    if (typeof cb === 'function') cb('denied');
    return Promise.resolve('denied');
  };

  try {
    Object.defineProperty(window, 'Notification', { value: Fake, configurable: true, writable: true });
  } catch (e) { /* page froze the property; the browser-level block still applies */ }

  if (window.ServiceWorkerRegistration) {
    try {
      ServiceWorkerRegistration.prototype.showNotification = () => Promise.resolve();
    } catch (e) { /* ignore */ }
  }
})();
