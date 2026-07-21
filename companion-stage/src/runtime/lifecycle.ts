export interface StageBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PointerTarget {
  readonly x: number;
  readonly y: number;
}

export function normalizePointer(
  clientX: number,
  clientY: number,
  bounds: StageBounds,
): PointerTarget {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 };
  const x = Math.max(-1, Math.min(1, ((clientX - bounds.left) / bounds.width) * 2 - 1));
  const y = Math.max(-1, Math.min(1, -(((clientY - bounds.top) / bounds.height) * 2 - 1)));
  return {
    x: x === 0 ? 0 : x,
    y: y === 0 ? 0 : y,
  };
}

export class DisposeBag {
  #disposed = false;
  readonly #callbacks: Array<() => void> = [];

  add(callback: () => void): void {
    if (this.#disposed) {
      callback();
      return;
    }
    this.#callbacks.push(callback);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const callback of this.#callbacks.splice(0).reverse()) callback();
  }
}
