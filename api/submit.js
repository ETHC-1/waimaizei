const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;
const adminPassword = process.env.ADMIN_PASSWORD;
const sessionSecret = process.env.ADMIN_SESSION_SECRET;
const dbName = 'takeaway_theft';
const collectionName = 'reports';

let cachedClient = null;
const rateLimits = new Map();

const LIMITS = { name: 60, location: 120, time: 40, food: 120, price: 20, story: 2000, contact: 120, comment: 1000 };

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 64);
}

function checkRateLimit(req, bucket, max, windowMs) {
  const key = `${bucket}:${getClientIp(req)}`;
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    rateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLength);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function createSession() {
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  const payload = String(expires);
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function isAdmin(req) {
  if (!sessionSecret) return false;
  const [expires, signature] = (parseCookies(req).admin_session || '').split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', sessionSecret).update(expires).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function validObjectId(value) {
  return typeof value === 'string' && ObjectId.isValid(value);
}

async function connectToDatabase() {
  if (!uri) throw new Error('MONGODB_URI is not configured');
  if (cachedClient) {
    return cachedClient;
  }
  const client = new MongoClient(uri);
  await client.connect();
  cachedClient = client;
  return client;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    try {
      const { action } = req.body;

      if (action === 'login') {
        if (!adminPassword || !sessionSecret) {
          res.status(503).json({ success: false, message: '管理员登录尚未配置' });
          return;
        }
        if (!checkRateLimit(req, 'login', 8, 15 * 60 * 1000)) {
          res.status(429).json({ success: false, message: '尝试次数过多，请稍后再试' });
          return;
        }
        const supplied = Buffer.from(cleanText(req.body.password, 200));
        const expected = Buffer.from(adminPassword);
        const matched = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
        if (!matched) {
          res.status(401).json({ success: false, message: '密码错误' });
          return;
        }
        const secureCookie = process.env.NODE_ENV === 'production' || process.env.VERCEL ? ' Secure;' : '';
        res.setHeader('Set-Cookie', `admin_session=${encodeURIComponent(createSession())}; HttpOnly;${secureCookie} SameSite=Lax; Path=/; Max-Age=28800`);
        res.status(200).json({ success: true });
        return;
      }

      // 添加评论
      if (action === 'comment') {
        const { id, name, text, commentId } = req.body;
        if (!validObjectId(id) || !cleanText(text, LIMITS.comment) || !checkRateLimit(req, 'comment', 20, 10 * 60 * 1000)) {
          res.status(400).json({ success: false, message: '参数不完整' });
          return;
        }
        const client = await connectToDatabase();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);
        await collection.updateOne(
          { _id: new ObjectId(id) },
          { $push: { comments: { id: cleanText(commentId, 80) || Date.now().toString(), name: cleanText(name, LIMITS.name) || '匿名用户', text: cleanText(text, LIMITS.comment), time: Date.now(), likes: 0, likedBy: [], replies: [] } } }
        );
        res.status(200).json({ success: true, message: '评论成功' });
        return;
      }

      // 点赞评论
      if (action === 'like') {
        const { id, commentId } = req.body;
        if (!validObjectId(id) || !cleanText(commentId, 80)) {
          res.status(400).json({ success: false, message: '参数不完整' });
          return;
        }
        const client = await connectToDatabase();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        const report = await collection.findOne({ _id: new ObjectId(id) });
        if (!report || !report.comments) {
          res.status(404).json({ success: false, message: '记录不存在' });
          return;
        }
        const comment = report.comments.find(c => c.id === commentId);
        if (!comment) {
          res.status(404).json({ success: false, message: '评论不存在' });
          return;
        }
        if (comment.likedBy && comment.likedBy.includes(userIp)) {
          res.status(200).json({ success: true, message: '已经点过赞了', alreadyLiked: true });
          return;
        }

        await collection.updateOne(
          { _id: new ObjectId(id), 'comments.id': commentId },
          { $inc: { 'comments.$.likes': 1 }, $push: { 'comments.$.likedBy': userIp } }
        );
        res.status(200).json({ success: true, message: '点赞成功' });
        return;
      }

      // 回复评论
      if (action === 'reply') {
        const { id, commentId, name, text, replyId } = req.body;
        if (!validObjectId(id) || !cleanText(commentId, 80) || !cleanText(text, LIMITS.comment) || !checkRateLimit(req, 'reply', 20, 10 * 60 * 1000)) {
          res.status(400).json({ success: false, message: '参数不完整' });
          return;
        }
        const client = await connectToDatabase();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);
        await collection.updateOne(
          { _id: new ObjectId(id), 'comments.id': commentId },
          { $push: { 'comments.$.replies': { id: cleanText(replyId, 80) || Date.now().toString(), name: cleanText(name, LIMITS.name) || '匿名用户', text: cleanText(text, LIMITS.comment), time: Date.now(), likes: 0, likedBy: [] } } }
        );
        res.status(200).json({ success: true, message: '回复成功' });
        return;
      }

      // 点赞子评论
      if (action === 'likeReply') {
        const { id, commentId, replyId } = req.body;
        if (!validObjectId(id) || !cleanText(commentId, 80) || !cleanText(replyId, 80)) {
          res.status(400).json({ success: false, message: '参数不完整' });
          return;
        }
        const client = await connectToDatabase();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        const report = await collection.findOne({ _id: new ObjectId(id) });
        if (!report || !report.comments) {
          res.status(404).json({ success: false, message: '记录不存在' });
          return;
        }
        const comment = report.comments.find(c => c.id === commentId);
        if (!comment || !comment.replies) {
          res.status(404).json({ success: false, message: '评论不存在' });
          return;
        }
        const reply = comment.replies.find(r => r.id === replyId);
        if (!reply) {
          res.status(404).json({ success: false, message: '回复不存在' });
          return;
        }
        if (reply.likedBy && reply.likedBy.includes(userIp)) {
          res.status(200).json({ success: true, message: '已经点过赞了', alreadyLiked: true });
          return;
        }

        reply.likes = (reply.likes || 0) + 1;
        if (!reply.likedBy) reply.likedBy = [];
        reply.likedBy.push(userIp);

        await collection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { comments: report.comments } }
        );
        res.status(200).json({ success: true, message: '点赞成功' });
        return;
      }

      // 点赞主帖（抱一抱）
      if (action === 'likeReport') {
        const { id } = req.body;
        if (!validObjectId(id)) {
          res.status(400).json({ success: false, message: '参数不完整' });
          return;
        }
        const client = await connectToDatabase();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        const report = await collection.findOne({ _id: new ObjectId(id) });
        if (!report) {
          res.status(404).json({ success: false, message: '记录不存在' });
          return;
        }
        if (report.likedBy && report.likedBy.includes(userIp)) {
          res.status(200).json({ success: true, message: '已经抱过了', alreadyLiked: true });
          return;
        }

        await collection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { likes: 1 }, $push: { likedBy: userIp } }
        );
        res.status(200).json({ success: true, message: '抱一抱成功' });
        return;
      }

      // 默认：提交新报告
      const { name, location, time, food, price, story, contact } = req.body;

      // 基础验证
      if (!cleanText(location, LIMITS.location) || !cleanText(time, LIMITS.time) || !cleanText(food, LIMITS.food) || !checkRateLimit(req, 'report', 10, 15 * 60 * 1000)) {
        res.status(400).json({ success: false, message: '请填写必填项' });
        return;
      }

      const client = await connectToDatabase();
      const db = client.db(dbName);
      const collection = db.collection(collectionName);

      const report = {
        name: cleanText(name, LIMITS.name) || '匿名用户',
        location: cleanText(location, LIMITS.location),
        time: cleanText(time, LIMITS.time),
        food: cleanText(food, LIMITS.food),
        price: cleanText(price, LIMITS.price),
        story: cleanText(story, LIMITS.story),
        contact: cleanText(contact, LIMITS.contact),
        createdAt: new Date(),
        ip: getClientIp(req),
        comments: [],
        likes: 0,
        likedBy: []
      };

      await collection.insertOne(report);

      res.status(200).json({ success: true, message: '提交成功，愿世间再无外卖贼！' });
    } catch (error) {
      console.error('提交失败:', error);
      res.status(500).json({ success: false, message: '服务器错误，请稍后重试' });
    }
  } else if (req.method === 'GET') {
    try {
      const client = await connectToDatabase();
      const db = client.db(dbName);
      const collection = db.collection(collectionName);

      const count = await collection.countDocuments();

      const admin = isAdmin(req);

      let reports;
      if (admin) {
        // 管理员模式：返回所有字段，最多1000条
        reports = await collection
          .find({})
          .sort({ createdAt: -1 })
          .limit(1000)
          .toArray();
      } else {
        // 公开模式：只返回非敏感字段，最近10条
        reports = await collection
          .find({}, { projection: { name: 1, location: 1, time: 1, food: 1, price: 1, story: 1, createdAt: 1, comments: 1, likes: 1 } })
          .sort({ createdAt: -1 })
          .limit(10)
          .toArray();
      }

      // 清理评论中的敏感字段
      reports = reports.map(r => {
        const { likedBy, ...reportRest } = r;
        if (reportRest.comments) {
          reportRest.comments = reportRest.comments.map(c => {
            const { likedBy: cLikedBy, ...cRest } = c;
            if (cRest.replies) {
              cRest.replies = cRest.replies.map(rep => {
                const { likedBy: rLikedBy, ...rRest } = rep;
                return rRest;
              });
            }
            return cRest;
          });
        }
        return reportRest;
      });

      res.status(200).json({
        success: true,
        total: count,
        recent: reports,
        admin
      });
    } catch (error) {
      console.error('查询失败:', error);
      res.status(500).json({ success: false, message: '查询失败' });
    }
  } else if (req.method === 'DELETE') {
    try {
      if (!isAdmin(req)) {
        res.status(403).json({ success: false, message: '无权操作' });
        return;
      }

      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ success: false, message: '请提供要删除的ID' });
        return;
      }

      const client = await connectToDatabase();
      const db = client.db(dbName);
      const collection = db.collection(collectionName);

      const objectIds = ids.map(id => new ObjectId(id));
      const result = await collection.deleteMany({ _id: { $in: objectIds } });

      res.status(200).json({
        success: true,
        message: `成功删除 ${result.deletedCount} 条记录`,
        deletedCount: result.deletedCount
      });
    } catch (error) {
      console.error('删除失败:', error);
      res.status(500).json({ success: false, message: '删除失败，请稍后重试' });
    }
  } else {
    res.status(405).json({ success: false, message: '方法不允许' });
  }
};
