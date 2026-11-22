import { Target, PageData } from "./api";

export interface Ctx {
  go(view: string, params?: any): void;
  openMemory(addr: number): void;
  openCode(func: number, off?: number): void;
  addBookmark(addr: number, type?: string, desc?: string): Promise<void>;
  data(): PageData;
  saveData(): Promise<void>;
  target(): Target | null;
}
export interface View {
  el: HTMLElement;
  show?(params?: any): void;
  hide?(): void;
  /** called when the selected target changes */
  retarget?(): void;
  onEvent?(type: string, data: any): void;
}
