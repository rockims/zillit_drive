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

export default socketClient;
