import type { GameRoom } from "./room.js";

type ScheduleFn = (room: GameRoom) => void;
type ImmediateFn = (room: GameRoom) => void | Promise<void>;

let scheduleFn: ScheduleFn | null = null;
let immediateFn: ImmediateFn | null = null;

export function registerPersistenceHooks(schedule: ScheduleFn, immediate: ImmediateFn) {
  scheduleFn = schedule;
  immediateFn = immediate;
}

export function scheduleRoomPersist(room: GameRoom) {
  scheduleFn?.(room);
}

export function persistRoomNow(room: GameRoom) {
  void immediateFn?.(room);
}
