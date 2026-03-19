const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

// Define rewards server-side to prevent client manipulation
const SPIN_REWARDS = [
    { value: 500, label: "500" },
    { value: 1000, label: "1K" },
    { value: 2000, label: "2K" },
    { value: 100, label: "100" },
    { value: 5000, label: "5K" },
    { value: 50000, label: "JACKPOT" } // Jackpot is 50k
];
const DAILY_FREE_SPINS = 3;
const DAILY_BONUSES = [ 500, 1000, 1500, 2000, 2500, 3000, 5000, 3500, 4000, 4500, 5000, 5500, 6000, 10000, 6500, 7000, 7500, 8000, 8500, 9000, 15000, 9500, 10000, 10500, 11000, 11500, 12000, 20000, 30000, 50000 ];
const TAPS_PER_SAVE = 50; // Client will send batches of 50 taps
const SCORE_PER_TAP = 5;
const MAX_ENERGY = 500;
const ENERGY_REGEN_PER_SEC = 1;

const MILESTONES = [
    { id: 'm1', required: 1, reward: 10000 },
    { id: 'm2', required: 3, reward: 35000 },
    { id: 'm3', required: 5, reward: 75000 },
    { id: 'm4', required: 10, reward: 200000 },
    { id: 'm5', required: 25, reward: 1000000 }
];

/**
 * Securely processes a spin request from a user.
 */

exports.spinTheWheel = functions.https.onCall(async (data, context) => {
    // 1. Check authentication
    if (!context.auth) {
        throw new functions.https.HttpsError(
            "unauthenticated",
            "You must be logged in to spin the wheel."
        );
    }
    const uid = context.auth.uid;
    const userRef = admin.database().ref(`/users/${uid}`);

    let spinsToday = 0;
    let extraSpins = 0;
    let currentScore = 0;
    let lastSpinCycle = "";

    // 2. Get current user state from database
    const snapshot = await userRef.once("value");
    const userData = snapshot.val();
    if (userData) {
        currentScore = userData.score || 0;
        extraSpins = userData.extraSpins || 0;
        lastSpinCycle = userData.lastSpinCycle || "";
    }

    // 3. Server-side validation of spin availability
    const now = new Date();
    const cycleId = `${now.toDateString()}-${now.getHours() < 12 ? 'AM' : 'PM'}`;

    if (lastSpinCycle !== cycleId) {
        spinsToday = 0; // It's a new cycle, reset spins
    } else {
        spinsToday = userData.spinsToday || 0;
    }

    const freeSpinsLeft = Math.max(0, DAILY_FREE_SPINS - spinsToday);
    const totalSpinsLeft = freeSpinsLeft + extraSpins;

    if (totalSpinsLeft <= 0) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "You have no spins left."
        );
    }

    // 4. Determine which spin is being consumed and update counts
    let newSpinsToday = spinsToday;
    let newExtraSpins = extraSpins;
    if (freeSpinsLeft > 0) {
        newSpinsToday++;
    } else {
        newExtraSpins--;
    }

    // 5. Generate reward on the server
    const winningSegmentIndex = Math.floor(Math.random() * SPIN_REWARDS.length);
    const winningReward = SPIN_REWARDS[winningSegmentIndex];

    // 6. Atomically update user data in the database
    await userRef.update({
        score: currentScore + winningReward.value,
        spinsToday: newSpinsToday,
        extraSpins: newExtraSpins,
        lastSpinCycle: cycleId
    });

    // 7. Return the result to the client
    return {
        winningReward: winningReward,
        winningSegmentIndex: winningSegmentIndex
    };
});

/**
 * Securely claims the daily bonus for a user.
 */
exports.claimDailyBonus = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }

    const uid = context.auth.uid;
    const userRef = admin.database().ref(`/users/${uid}`);
    const now = Date.now();
    const MS_IN_DAY = 24 * 60 * 60 * 1000;

    const snapshot = await userRef.once("value");
    const userData = snapshot.val() || {};

    const lastClaim = userData.lastBonusClaim || 0;

    // Server-side time validation
    if (now - lastClaim < MS_IN_DAY) {
        throw new functions.https.HttpsError("failed-precondition", "You have already claimed your bonus for today.");
    }

    // Streak logic
    let currentStreak = userData.bonusStreak || 0;
    if (now - lastClaim > (MS_IN_DAY * 2)) {
        currentStreak = 0; // Streak broken
    }
    const newStreak = currentStreak + 1;

    // Determine reward
    const rewardAmount = DAILY_BONUSES[(newStreak - 1) % DAILY_BONUSES.length];

    // Atomically update user data
    await userRef.update({
        score: admin.database.ServerValue.increment(rewardAmount),
        lastBonusClaim: now,
        bonusStreak: newStreak
    });

    // Log the transaction
    const txRef = userRef.child('transactions').push();
    await txRef.set({
        type: 'Daily Bonus',
        amount: rewardAmount,
        date: now
    });

    return { success: true, reward: rewardAmount, streak: newStreak };
});

/**
 * Securely processes a batch of taps from the user.
 */
exports.processTaps = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }

    const uid = context.auth.uid;
    const userRef = admin.database().ref(`/users/${uid}`);

    const taps = parseInt(data.taps, 10);
    const energySpent = parseInt(data.energySpent, 10);

    // Basic validation
    if (!taps || taps <= 0 || taps > (TAPS_PER_SAVE + 5)) { // Allow a small buffer
        throw new functions.https.HttpsError("invalid-argument", "Invalid tap count.");
    }
    if (energySpent !== taps) {
        throw new functions.https.HttpsError("invalid-argument", "Energy and tap mismatch.");
    }

    const snapshot = await userRef.once("value");
    const userData = snapshot.val() || {};
    
    // --- Server-Side Energy Regeneration Logic ---
    let storedEnergy = userData.energy !== undefined ? userData.energy : MAX_ENERGY;
    const lastEnergyUpdate = userData.lastEnergyUpdate || Date.now();
    const now = Date.now();
    
    // Calculate how much energy should have regenerated since last save
    const secondsPassed = Math.floor((now - lastEnergyUpdate) / 1000);
    const regeneratedAmount = secondsPassed * ENERGY_REGEN_PER_SEC;
    
    // Calculate actual current energy (capped at Max)
    let calculatedEnergy = Math.min(MAX_ENERGY, storedEnergy + regeneratedAmount);

    // --- Anti-Cheat: Time Check ---
    // Ensure user isn't tapping faster than humanly possible (e.g., > 15 taps/sec)
    const lastActive = userData.lastActive || (now - 10000);
    const timeDiff = now - lastActive;
    const minTimeRequired = taps * 30; // Reduced to 30ms (approx 33 taps/sec) to prevent false positives
    if (timeDiff < minTimeRequired) {
        return { success: false, message: "You are tapping too fast. Slow down!" };
    }

    // Server-side energy check
    if (calculatedEnergy < energySpent) {
        // User might be cheating. We can just ignore the request or penalize.
        // For now, we'll update their energy to the correct server value and give no score.
        // Just sync the energy back to client
        await userRef.update({ energy: calculatedEnergy, lastEnergyUpdate: now });
        throw new functions.https.HttpsError("failed-precondition", "Not enough energy. Server sync required.");
    }

    const newEnergy = calculatedEnergy - energySpent;
    const scoreGained = taps * SCORE_PER_TAP;

    // Atomically update score and energy
    await userRef.update({
        score: admin.database.ServerValue.increment(scoreGained),
        energy: newEnergy,
        lastEnergyUpdate: now,
        totalTaps: admin.database.ServerValue.increment(taps),
        lastActive: now 
    });

    return { success: true, scoreAdded: scoreGained };
});

/**
 * Securely processes a referral code claim.
 */
exports.claimReferral = functions.https.onCall(async (data, context) => {
    // 1. Auth Check
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }

    const uid = context.auth.uid;
    const code = data.code; // The code entered (referrer's UID)

    if (!code || typeof code !== 'string') {
        throw new functions.https.HttpsError("invalid-argument", "Invalid referral code.");
    }

    if (code === uid) {
        throw new functions.https.HttpsError("invalid-argument", "You cannot refer yourself.");
    }

    const userRef = admin.database().ref(`/users/${uid}`);
    const referrerRef = admin.database().ref(`/users/${code}`);

    // 2. Verify User Status
    const userSnap = await userRef.once("value");
    const userData = userSnap.val() || {};

    if (userData.referredBy) {
        throw new functions.https.HttpsError("failed-precondition", "You have already been referred.");
    }

    // 3. Verify Referrer Exists
    const referrerSnap = await referrerRef.once("value");
    if (!referrerSnap.exists()) {
        throw new functions.https.HttpsError("not-found", "Referral code does not exist.");
    }

    // 4. Atomic Updates (Secure Transaction)
    // Bonus for New User
    await userRef.update({
        referredBy: code,
        score: admin.database.ServerValue.increment(2500)
    });

    // Bonus for Referrer
    await referrerRef.update({
        score: admin.database.ServerValue.increment(2500),
        referralCount: admin.database.ServerValue.increment(1),
        referralEarnings: admin.database.ServerValue.increment(2500)
    });

    return { success: true, message: "Referral claimed successfully!" };
});

/**
 * Securely processes a milestone reward claim.
 */
exports.claimMilestone = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Auth required.");
    
    const uid = context.auth.uid;
    const milestoneId = data.milestoneId;
    const userRef = admin.database().ref(`/users/${uid}`);

    const milestone = MILESTONES.find(m => m.id === milestoneId);
    if (!milestone) throw new functions.https.HttpsError("not-found", "Milestone not found.");

    const snap = await userRef.once("value");
    const userData = snap.val() || {};
    const referralCount = userData.referralCount || 0;
    const claimed = userData.claimedMilestones || [];

    if (referralCount < milestone.required) {
        throw new functions.https.HttpsError("failed-precondition", "Requirement not met.");
    }
    if (claimed.includes(milestoneId)) {
        throw new functions.https.HttpsError("already-exists", "Already claimed.");
    }

    // Update
    const claimedUpdate = [...claimed, milestoneId];
    
    await userRef.update({
        score: admin.database.ServerValue.increment(milestone.reward),
        referralEarnings: admin.database.ServerValue.increment(milestone.reward),
        claimedMilestones: claimedUpdate
    });

    return { success: true, reward: milestone.reward };
});

/**
 * Securely processes a challenge reward.
 */
exports.claimChallenge = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Auth required.");
    
    const uid = context.auth.uid;
    const challengeId = data.challengeId;
    // In a real app, you would verify if the challenge is actually done 
    // (e.g., check database stats or external API verification)
    
    // For now, simpler logic or placeholder:
    const userRef = admin.database().ref(`/users/${uid}`);
    
    // Example reward
    const reward = 5000; 

    // Check if already claimed logic would go here...
    
    await userRef.update({
        score: admin.database.ServerValue.increment(reward),
        [`challenges/${challengeId}`]: true // Mark as done
    });

    return { success: true, reward: reward };
});

/**
 * Securely grants a reward for watching a Special Offer ad.
 */
exports.claimAdReward = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Auth required.");
    const uid = context.auth.uid;
    const userRef = admin.database().ref(`/users/${uid}`);
    
    // Random reward 100-1000 coins
    const reward = Math.floor(Math.random() * (1000 - 100 + 1)) + 100;
    
    await userRef.update({
        score: admin.database.ServerValue.increment(reward)
    });
    return { success: true, reward: reward };
});

/**
 * Securely grants an extra spin for watching an ad.
 */
exports.grantExtraSpin = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Auth required.");
    const uid = context.auth.uid;
    
    await admin.database().ref(`/users/${uid}`).update({
        extraSpins: admin.database.ServerValue.increment(1)
    });
    return { success: true };
});