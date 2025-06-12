const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("🤖 Bot is alive!");
});

app.listen(3000, () => console.log("🌐 Web server running on port 3000"));

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const admin = require("firebase-admin");
const serviceAccount = require("./firebaseServiceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});
const voiceTimers = new Map();
const userVoiceData = new Map();
const mentionCooldown = new Map();

const LEVELS = [
  { threshold: 10, name: "Beginner" },
  { threshold: 30, name: "Jr Cyber Apprentice" },
  { threshold: 55, name: "Cyber Expert" },
  { threshold: 60, name: "Hacker Novice" },
  { threshold: 75, name: "Hacker" },
  { threshold: 100, name: "Cybersecurity Champion" },
];

// On voice join/leave
client.on("voiceStateUpdate", (oldState, newState) => {
  const userId = newState.id;

  if (!oldState.channel && newState.channel) {
    // Joined voice → start timer
    voiceTimers.set(userId, Date.now());
  } else if (oldState.channel && !newState.channel && voiceTimers.has(userId)) {
    const seconds = Math.floor((Date.now() - voiceTimers.get(userId)) / 1000);
    voiceTimers.delete(userId);
    const pointsToAdd = Math.floor(seconds / 30);
    if (pointsToAdd > 0) updatePointsAndNickname(newState.member, pointsToAdd);
  }
});
const thanksCooldown = new Map();

const PREFIX = "!";
const rateLimit = new Map();

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  setInterval(trackVoicePoints, 30 * 1000);
});

client.on("guildMemberAdd", async (member) => {
  const verifyChannel = await member.guild.channels.create({
    name: `verify-${member.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, ""),
    type: 0,
    permissionOverwrites: [
      {
        id: member.guild.roles.everyone.id,
        deny: ["ViewChannel"],
      },
      {
        id: member.user.id,
        allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
      },
      {
        id: client.user.id,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "ManageChannels",
          "ManageRoles",
        ],
      },
    ],
  });

  verifyChannel.send(
    `Welcome ${member}! Please enter the OTP password to verify yourself.`,
  );

  const collector = verifyChannel.createMessageCollector({
    filter: (m) => m.author.id === member.id,
    time: 5 * 60 * 1000,
    max: 1,
  });

  collector.on("collect", async (msg) => {
    const doc = await db.collection("server_password").doc("current").get();
    const currentOtp = doc.exists ? doc.data().password : null;

    if (msg.content.trim().toUpperCase() === currentOtp) {
      const role = member.guild.roles.cache.find((r) => r.name === "Verified");
      if (role) {
        await member.roles.add(role);
        await verifyChannel.send("✅ You have been verified!");

        // Generate a new OTP
        const newOtp = Math.random().toString(36).slice(-8).toUpperCase();
        await db
          .collection("server_password")
          .doc("current")
          .set({ password: newOtp }, { merge: true });

        // Fetch admins and notify them
        const guild = member.guild;
        await guild.members.fetch();
        const admins = guild.members.cache.filter(
          (m) => m.permissions.has("Administrator") && !m.user.bot,
        );

        admins.forEach((admin) => {
          try {
            admin.send(
              `👤 User ${member.user.tag} has been verified.\nPlease review and approve them using the command:\n!apr ${member.user.username}`,
            );
          } catch (err) {
            console.warn(`Could not DM ${admin.user.tag}:`, err.message);
          }
        });

        setTimeout(() => verifyChannel.delete().catch(() => {}), 3000);
      } else {
        await verifyChannel.send(
          "❌ Verified role not found. Contact an admin.",
        );
      }
    } else {
      await verifyChannel.send(
        "❌ Incorrect OTP. Try again or contact support.",
      );
    }
  });

  collector.on("end", (collected) => {
    if (collected.size === 0) {
      verifyChannel
        .send("⌛ Verification timed out. Please try again later.")
        .then(() =>
          setTimeout(() => verifyChannel.delete().catch(() => {}), 5000),
        );
    }
  });
});

client.on("messageCreate", async (message) => {
  if (msg.author.bot || !msg.guild) return;
  const isCommand = msg.content.startsWith(PREFIX);

  if (!isCommand && msg.mentions.users.size > 0) {
    for (const user of msg.mentions.users.values()) {
      const key = `${msg.guild.id}-${user.id}`;
      const now = Date.now();
      if (
        !mentionCooldown.has(key) ||
        now - mentionCooldown.get(key) > 20 * 60 * 1000
      ) {
        const member = msg.guild.members.cache.get(user.id);
        if (member && !member.user.bot) {
          await addPoints(member, 5);
          mentionCooldown.set(key, now);
          msg.channel.send(`👍 ${member.user.username} has been thanked!`);
        }
      }
    }
  }
  const isAdminChannel = message.channel.name === "commands";
  const isGeneralChannel = message.channel.name === "general";
  if (message.author.bot) return;

  if (message.content.startsWith("!thanks ")) {
    const mention = message.mentions.members.first();
    if (!mention) return message.reply("Please mention someone to thank.");

    if (mention.id === message.author.id)
      return message.reply("You can’t thank yourself!");
    const now = Date.now();
    const last = thanksCooldown.get(message.author.id) || 0;
    if (now - last < 20 * 60 * 1000) {
      return message.reply("You need to wait before thanking again.");
    }
    thanksCooldown.set(message.author.id, now);
    updatePointsAndNickname(mention, 5);
    message.channel.send({
      content: `👍 ${mention.user.tag} has been thanked!`,
    });
  }
  // ✅ General channel rate limit
  if (isGeneralChannel) {
    const userId = message.author.id;
    const now = Date.now();
    const data = rateLimit.get(userId) || { count: 0, time: now };

    if (now - data.time > 10000) {
      data.count = 1;
      data.time = now;
    } else {
      data.count += 1;
    }

    if (data.count > 5) {
      await message.delete().catch(() => {});
      await message.author.send(
        "⏱️ You are sending messages too fast in #general. Max 5 per 10s.",
      );
      return;
    }

    rateLimit.set(userId, data);

    const approvedRole = message.guild.roles.cache.find(
      (r) => r.name === "Approved",
    );
    if (!message.member.roles.cache.has(approvedRole?.id)) {
      await message.delete().catch(() => {});
      await message.author.send("⛔ Only approved users can chat in #general.");
    }

    return;
  }

  if (isCommand) {
    const [cmd, ...args] = message.content
      .trim()
      .substring(PREFIX.length)
      .split(/\s+/);

    if (cmd === "verify") {
      const otp = args[0];
      const snapshot = await db
        .collection("otps")
        .where("otp", "==", otp)
        .where("used", "==", false)
        .get();

      if (snapshot.empty) {
        return message.reply("Invalid or used OTP.");
      }

      const doc = snapshot.docs[0];
      await doc.ref.update({ used: true });

      const role = message.guild.roles.cache.find((r) => r.name === "Verified");
      if (role) {
        await message.member.roles.add(role);
        return message.reply("✅ You have been verified!");
      } else {
        return message.reply("Verified role not found. Contact an admin.");
      }
    }

    if (cmd === "genotp") {
      //if (!message.member.permissions.has("Administrator")) return;
      const mention = message.mentions.users.first();
      if (!mention) return message.reply("Mention a user.");

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await db.collection("otps").add({ id: mention.id, otp, used: false });

      mention.send(`Your OTP code is: ${otp}`);
      return message.reply(`OTP generated for ${mention.tag}`);
    }

    if (isAdminChannel /*&& message.member.permissions.has("Administrator")*/) {
      if (cmd === "authreset") {
        const verifiedRole = message.guild.roles.cache.find(
          (r) => r.name === "Verified",
        );
        const members = await message.guild.members.fetch();

        members.forEach(async (member) => {
          if (member.roles.cache.has(verifiedRole?.id)) {
            await member.roles.remove(verifiedRole);
            await member.send("🔁 Please re-verify using your OTP.");
          }
        });

        return message.reply(
          "All users have been reset and must re-authenticate.",
        );
      }

      if (cmd === "apr") {
        await message.guild.members.fetch(); // make sure all members are available

        const mention = message.mentions.members.first();
        if (!mention)
          return message.reply(
            "❗ Please mention a user to approve, like `!apr @username`",
          );

        const verifiedRole = message.guild.roles.cache.find(
          (r) => r.name === "Verified",
        );
        const approvedRole = message.guild.roles.cache.find(
          (r) => r.name === "Approved",
        );

        if (!verifiedRole || !approvedRole) {
          return message.reply(
            "❌ Required roles not found. Make sure 'Verified' and 'Approved' roles exist.",
          );
        }

        if (!mention.roles.cache.has(verifiedRole.id)) {
          return message.reply("🚫 That user is not Verified yet.");
        }

        await mention.roles.add(approvedRole);
        return message.reply(`✅ ${mention.user.tag} is now Approved.`);
      }
    }
  }
});
client.login(
  "MTM4MjY5ODA2NDg5NjA2NTU0Ng.GPHaSc.fLzcBtKZjd129h3cF7DwlwDr4dNG_IMHxxrwlk",
);
function trackVoicePoints() {
  client.guilds.cache.forEach(async (guild) => {
    guild.members.cache.forEach(async (member) => {
      if (member.voice.channel && !member.user.bot) {
        await addPoints(member, 1);
      }
    });
  });
}

// Points Handler
async function addPoints(member, amount) {
  const ref = db.collection("users").doc(member.id);
  const doc = await ref.get();
  let data = doc.exists ? doc.data() : { points: 0, level: 0 };
  data.points += amount;

  const currentLevel = levels[data.level];
  if (data.points >= currentLevel.points) {
    await member.send(`🎉 You earned the title: ${currentLevel.title}`);
    data.points = 0;
    data.level = Math.min(data.level + 1, levels.length - 1);
  }

  await ref.set(data);
  updateNickname(member, data);
}

async function updateNickname(member, data) {
  const levelData = levels[data.level];
  const nick = `${member.user.username} [${levelData.title.toUpperCase()}] ${data.points}/${levelData.points}`;
  try {
    await member.setNickname(nick.slice(0, 32));
  } catch (err) {
    console.warn(`Failed to set nickname for ${member.user.tag}:`, err.message);
  }
}
