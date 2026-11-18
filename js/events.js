// Tells the sync module that something worth syncing changed on this device.
export const bus = new EventTarget();
export const touch = () => bus.dispatchEvent(new Event('local-change'));
