import dotenv from 'dotenv';
import { socketBasic } from 'zillit-libs/config';

dotenv.config();

const connection = socketBasic(process.env.COMMON_SOCKET_URL, { module: process.env.module_code });

const socketClient = (event, data) => {
  connection.emit(event, data, (resp) => {
    if (data?.room) {
      console.log(`[socket][${data?.room}][${data?.event}][${JSON.stringify(data?.data)}] ->`, resp.success);
    } else {
      console.log(`[socket][${event}][${JSON.stringify(data)}] ->`, resp.success);
    }
  });
};

/**
 * ZL-18799: Fan-out emit to per-user rooms instead of a project-wide room.
 * Use when an event must reach only users with access — e.g. drive new
 * file/folder creates, where project-wide broadcast leaks items into other
 * users' "Shared with Me".
 *
 * Each user_id (as string) is the room they subscribe to — same per-user room
 * pattern that zillit_libs notification service uses (`room: receiver.toString()`).
 *
 * Auto-dedupes user IDs and skips falsy entries. No-op when userIds is empty.
 */
const emitToUserRooms = (channel, payload, userIds = []) => {
  const uniqueRooms = Array.from(new Set(
    (userIds || []).map((id) => (id ? id.toString() : null)).filter(Boolean),
  ));
  uniqueRooms.forEach((room) => {
    socketClient(channel, { ...payload, room });
  });
};

export default socketClient;
export { emitToUserRooms };
