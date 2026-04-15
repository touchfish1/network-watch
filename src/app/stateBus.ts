type AppBusEventMap = {
  "app:click-through-changed": boolean;
  "app:settings-changed": { key: string };
  "app:alert-raised": { id: string; title: string; message: string; timestamp: number };
};

export function emitAppEvent<K extends keyof AppBusEventMap>(type: K, detail: AppBusEventMap[K]) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

export function listenAppEvent<K extends keyof AppBusEventMap>(
  type: K,
  handler: (detail: AppBusEventMap[K]) => void,
) {
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<AppBusEventMap[K]>;
    handler(customEvent.detail);
  };
  window.addEventListener(type, listener as EventListener);
  return () => {
    window.removeEventListener(type, listener as EventListener);
  };
}
