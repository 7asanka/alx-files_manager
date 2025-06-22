import { v4 as uuidv4 } from 'uuid';
import sha1 from 'sha1';
import redisClient from '../utils/redis.js';
import dbClient from '../utils/db.js';
/* eslint-disable import/no-named-as-default */

class AuthController {
  static async getConnect(req, res) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) return res.status(401).json({ error: 'Unauthorized' });

    const base64 = header.split(' ')[1];
    const decoded = Buffer.from(base64, 'base64').toString();
    const [email, password] = decoded.split(':');

    const user = await dbClient.db.collection('users').findOne({ email, password: sha1(password) });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const token = uuidv4();
    const key = `auth_${token}`;
    await redisClient.set(key, user._id.toString(), 60 * 60 * 24);

    return res.status(200).json({ token });
  }

  static async getDisconnect(req, res) {
    const token = req.headers['x-token'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const key = `auth_${token}`;
    const userId = await redisClient.get(key);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await redisClient.del(key);
    return res.status(204).send();
  }
}

export default AuthController;
