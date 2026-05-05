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
 * Build a deduped array of user-room strings for use as the socket emit's
 * `room` field. The socket server accepts `room: [...]` and broadcasts to all
 * rooms in a single emit (see zillit_project_managment::permission.js for the
 * canonical pattern). Each user_id (as string) is the room they subscribe to
 * — same per-user delivery pattern zillit_libs notification service uses.
 *
 * Filters out falsy IDs and dedupes. Returns empty array if no recipients.
 */
const buildUserRooms = (userIds = []) => Array.from(new Set(
  (userIds || []).map((id) => (id ? id.toString() : null)).filter(Boolean),
));

export default socketClient;
export { buildUserRooms };
