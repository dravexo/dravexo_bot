const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require("cors"); // Import the cors package

admin.initializeApp();
const db = admin.database();

// Configure CORS to ONLY allow requests from your local development server.
// For production, you might want to restrict this further or allow your deployed web app's URL.
const corsHandler = cors({ origin: true }); // 'true' allows all origins (easiest for testing) or use "https://dravexo.github.io"

// --- RATE LIMITING & BOT DETECTION CONFIG ---
const RATE_LIMITS = {
    tap: 50, // Min ms between taps (Anti-macro)
    api: 1000, // Min ms between heavy API calls (Leaderboard etc)
    maxTapsPerSecond: 15 // Sustained taps per second threshold
};

// Helper: Calculate Standard Deviation (for consistency check)
function calculateStdDev(numbers) {
    if (numbers.length === 0) return 0;
    const mean = numbers.reduce((a, b) => a + b) / numbers.length;
    const variance = numbers.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numbers.length;
    return Math.sqrt(variance);
}

// Helper function to securely authenticate a user from a request.
async function getAuthenticatedUser(req, res) {
    if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
        res.status(403).send('Unauthorized: No token provided.');
        return null;
    }
    const idToken = req.headers.authorization.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        return decodedToken.uid;
    } catch (error) {
        res.status(403).send('Unauthorized: Invalid token.');
        return null;
    }
}

// Rewritten processTap function using onRequest for CORS control
exports.processTap = functions.https.onRequest((req, res) => {
    // 1. Handle CORS
    corsHandler(req, res, async () => {
        // 2. Authenticate user
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return; // Auth failed, response already sent by helper

        const userRef = db.ref(`/users/${userId}`);

        // 3. Run the game logic in a transaction
        try {
            const transactionResult = await userRef.transaction(currentUserData => {
                if (currentUserData === null) {
                    return { score: 5, energy: 500, maxEnergy: 500, lastTap: admin.database.ServerValue.TIMESTAMP, isBanned: false };
                }
                
                // 1. SECURITY: Ban Check (Server Side)
                if (currentUserData.isBanned || currentUserData.energy < 1) {
                    return; // Abort transaction
                }

                const now = Date.now();
                const lastTap = currentUserData.lastTap || 0;
                
                // 2. RATE LIMIT: Basic Speed Limit
                if (now - lastTap < RATE_LIMITS.tap) { 
                    return; // Abort, too fast
                }

                // 3. AI ANTI-CHEAT: Analyze Tap Pattern
                // Store last 10 tap timestamps to analyze pattern
                let tapHistory = currentUserData.tapHistory || [];
                tapHistory.push(now);
                if (tapHistory.length > 10) tapHistory.shift(); // Keep only last 10
                
                if (tapHistory.length >= 10) {
                    // Calculate intervals between taps
                    let intervals = [];
                    for(let i = 1; i < tapHistory.length; i++) {
                        intervals.push(tapHistory[i] - tapHistory[i-1]);
                    }

                    // A. Speed Check: Average interval < 60ms means > 16 taps/sec (Superhuman)
                    const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
                    
                    // B. Consistency Check: Low standard deviation means robotic precision
                    const stdDev = calculateStdDev(intervals);

                    if (avgInterval < 60 || (stdDev < 5 && avgInterval < 300)) {
                        currentUserData.isBanned = true;
                        return currentUserData; // Apply ban immediately
                    }
                }

                currentUserData.score = (currentUserData.score || 0) + 5;
                currentUserData.energy -= 1;
                currentUserData.lastTap = admin.database.ServerValue.TIMESTAMP;
                currentUserData.totalTaps = (currentUserData.totalTaps || 0) + 1;
                currentUserData.tapHistory = tapHistory;

                return currentUserData;
            });

            if (transactionResult.committed) {
                const data = transactionResult.snapshot.val();
                if (data.isBanned) {
                     res.status(403).json({ success: false, message: "Account Banned: Suspicious Activity Detected" });
                } else {
                    res.status(200).json({ success: true, data: data });
                }
            } else {
                res.status(400).json({ success: false, message: "Could not process tap. Not enough energy or too fast." });
            }
        } catch (error) {
            console.error("Tap Transaction failed:", error);
            res.status(500).json({ success: false, message: "Internal server error during tap." });
        }
    });
});

// Rewritten spinTheWheel function using onRequest
exports.spinTheWheel = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;

        const userRef = db.ref(`/users/${userId}`);
        const SPIN_COST = 100;

        try {
            const transactionResult = await userRef.transaction(userData => {
                if (userData === null || userData.isBanned) return;
                if ((userData.energy || 0) < SPIN_COST) return; // Not enough energy, abort.

                userData.energy -= SPIN_COST;

                const rewards = [
                    { value: 500, label: '500' }, { value: 1000, label: '1K' },
                    { value: 2000, label: '2K' }, { value: 100, label: '100' },
                    { value: 5000, label: '5K' }, { value: 50000, label: 'JACKPOT' }
                ];
                const winningSegmentIndex = Math.floor(Math.random() * rewards.length);
                const winningReward = rewards[winningSegmentIndex];
                userData.score = (userData.score || 0) + winningReward.value;

                // We need to pass the result out of the transaction
                userData.lastSpinResult = {
                    winningSegmentIndex: winningSegmentIndex,
                    finalAmount: winningReward.value
                };

                return userData;
            });

            if (transactionResult.committed) {
                const finalData = transactionResult.snapshot.val();
                res.status(200).json({
                    success: true,
                    winningSegmentIndex: finalData.lastSpinResult.winningSegmentIndex,
                    finalAmount: finalData.lastSpinResult.finalAmount
                });
            } else {
                res.status(400).json({ success: false, message: "Could not spin. Not enough energy or account is banned." });
            }
        } catch (error) {
            console.error("Spin transaction failed:", error);
            res.status(500).json({ success: false, message: "Internal server error during spin." });
        }
    });
});

// ==================================================================
// 3. DAILY BONUS SYSTEM (Server-Side)
// ==================================================================
exports.getDailyBonusStatus = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;

        const userRef = db.ref(`/users/${userId}`);
        const snapshot = await userRef.once('value');
        const userData = snapshot.val() || {};

        const lastClaim = userData.lastBonusClaim || 0;
        const streak = userData.bonusStreak || 0;
        const now = Date.now();
        const MS_IN_DAY = 24 * 60 * 60 * 1000;
        
        // Calculate time diff
        const timeDiff = now - lastClaim;
        const isClaimable = timeDiff >= MS_IN_DAY;
        
        // Check if streak is broken (e.g., missed 48 hours)
        let currentStreak = streak;
        if (timeDiff > (MS_IN_DAY * 2)) {
            currentStreak = 0; // Reset streak
        }

        res.status(200).json({
            success: true,
            isClaimable: isClaimable,
            streakDays: currentStreak + 1, // Display next day
            nextClaimTime: lastClaim + MS_IN_DAY
        });
    });
});

exports.claimDailyBonus = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;

        const userRef = db.ref(`/users/${userId}`);
        
        try {
            const result = await userRef.transaction(userData => {
                if (!userData) return;
                if (userData.isBanned) return;

                const now = Date.now();
                const lastClaim = userData.lastBonusClaim || 0;
                const MS_IN_DAY = 24 * 60 * 60 * 1000;

                if (now - lastClaim < MS_IN_DAY) {
                    return; // Cooldown active
                }

                // Logic for Streak
                if (now - lastClaim > (MS_IN_DAY * 2)) {
                    userData.bonusStreak = 0; // Reset
                }
                
                const streak = (userData.bonusStreak || 0) + 1;
                userData.bonusStreak = streak;
                userData.lastBonusClaim = now;

                // Calculate Reward based on streak
                const rewards = [500, 1000, 1500, 2000, 2500, 3000, 5000]; // 7 Days
                let rewardAmount = rewards[(streak - 1) % rewards.length];
                
                // Day 30 huge bonus logic can be added here

                userData.score = (userData.score || 0) + rewardAmount;
                userData.lastRewardAmount = rewardAmount; // Temp storage for response

                return userData;
            });

            if (result.committed) {
                res.status(200).json({ success: true, amount: result.snapshot.val().lastRewardAmount });
            } else {
                res.status(400).json({ success: false, message: "Bonus not available yet." });
            }
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, message: "Server error." });
        }
    });
});

// ==================================================================
// 4. SECURE REFERRAL SYSTEM & MILESTONES
// ==================================================================
exports.getReferralData = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;

        // In a real app, you might store referrals in a separate collection/path
        // For simplicity, assuming user object has 'referrals' count and 'referralEarnings'
        const userSnap = await db.ref(`users/${userId}`).once('value');
        const userData = userSnap.val() || {};

        res.status(200).json({
            success: true,
            invitedCount: userData.referralCount || 0,
            totalEarnings: userData.referralEarnings || 0,
            claimedMilestones: userData.claimedMilestones || []
        });
    });
});

exports.claimReferralMilestone = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;
        const { milestoneId } = req.body; // Pass milestone ID from client

        const userRef = db.ref(`users/${userId}`);
        
        await userRef.transaction(userData => {
            if (!userData) return;
            if (userData.isBanned) return; // Ban check added
            const referrals = userData.referralCount || 0;
            const claimed = userData.claimedMilestones || [];

            if (claimed.includes(milestoneId)) return; // Already claimed

            // Define Milestones Server-Side
            const milestones = {
                'm1': { req: 1, reward: 10000 },
                'm2': { req: 3, reward: 35000 },
                'm3': { req: 5, reward: 75000 },
                'm4': { req: 10, reward: 200000 },
                'm5': { req: 25, reward: 1000000 }
            };

            const milestone = milestones[milestoneId];
            if (!milestone || referrals < milestone.req) return; // Not eligible

            // Grant Reward
            userData.score = (userData.score || 0) + milestone.reward;
            if (!userData.claimedMilestones) userData.claimedMilestones = [];
            userData.claimedMilestones.push(milestoneId);
            
            return userData;
        });

        res.status(200).json({ success: true, message: "Milestone claimed!" });
    });
});

// ==================================================================
// Helper to generate a unique referral code
// ==================================================================
async function createUniqueReferralCode(userId) {
    const codesRef = db.ref('referralCodes');
    let code;
    let isUnique = false;
    while (!isUnique) {
        // Generate a 6-character alphanumeric code
        code = Math.random().toString(36).substring(2, 8).toUpperCase();
        const snapshot = await codesRef.child(code).once('value');
        if (!snapshot.exists()) {
            isUnique = true;
        }
    }
    // Map the code to the user ID and vice-versa
    await codesRef.child(code).set(userId);
    await db.ref(`users/${userId}/referralCode`).set(code);
    return code;
}

exports.getReferralCode = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;
        const userSnap = await db.ref(`users/${userId}/referralCode`).once('value');
        let code = userSnap.val();
        if (!code) code = await createUniqueReferralCode(userId);
        res.status(200).json({ success: true, code: code });
    });
});
// ==================================================================
// 6. SUBMIT REFERRAL (Secure)
// ==================================================================
// 9. SUBMIT REFERRAL CODE (New Feature)
// ==================================================================
exports.submitReferralCode = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;

        const { referralCode } = req.body; // The unique code of the referrer

        if (!referralCode) {
            return res.status(400).json({ success: false, message: "Invalid referral code." });
        }

        try {
            // 1. Find the referrer's UID from the code
            const codeSnap = await db.ref(`referralCodes/${referralCode.toUpperCase()}`).once('value');
            if (!codeSnap.exists()) {
                return res.status(404).json({ success: false, message: "Referral code not found." });
            }
            const referrerId = codeSnap.val();

            // Self-referral check
            if (referrerId === userId) {
                return res.status(400).json({ success: false, message: "You cannot use your own code." });
            }

            // 2. Check if user has already used a code
            const userRef = db.ref(`users/${userId}`);
            const userSnap = await userRef.once('value');
            const userData = userSnap.val() || {};
            if (userData.referredBy) {
                return res.status(400).json({ success: false, message: "You have already used a referral code." });
            }

            // 3. Process Referral
            const referrerRef = db.ref(`users/${referrerId}`);
            await referrerRef.transaction(data => {
                if (!data) return;
                data.referralCount = (data.referralCount || 0) + 1;
                data.score = (data.score || 0) + 5000; // Bonus for referrer
                return data;
            });
            
            await userRef.update({ referredBy: referrerId, score: (userData.score || 0) + 2500 }); // Bonus for user

            res.status(200).json({ success: true, message: "Referral code applied! You got 2500 coins." });
        } catch (error) {
            console.error("Referral Error:", error);
            res.status(500).json({ success: false, message: "Server error." });
        }
    });
});

// ==================================================================
// 7. CHALLENGES SYSTEM (Server-Side)
// ==================================================================
exports.getChallengeStatus = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;

        const userSnap = await db.ref(`users/${userId}`).once('value');
        const userData = userSnap.val() || {};

        // Send back current progress for the client to render
        res.status(200).json({
            success: true,
            totalTaps: userData.totalTaps || 0,
            totalAdsWatched: userData.totalAdsWatched || 0,
            claimedChallenges: userData.claimedChallenges || []
        });
    });
});

exports.claimChallengeReward = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;
        const { challengeId } = req.body;

        const userRef = db.ref(`users/${userId}`);
        
        // Define challenges on the server to prevent manipulation
        const challenges = {
            'tap_100': { type: 'taps', target: 100, reward: 500 },
            'tap_500': { type: 'taps', target: 500, reward: 2000 },
            'tap_2000': { type: 'taps', target: 2000, reward: 5000 },
            'ads_10': { type: 'ads', target: 10, reward: 5000 }
        };

        const challenge = challenges[challengeId];
        if (!challenge) {
            return res.status(400).json({ success: false, message: "Invalid challenge." });
        }

        try {
            const result = await userRef.transaction(userData => {
                if (!userData || userData.isBanned) return;

                const claimed = userData.claimedChallenges || [];
                if (claimed.includes(challengeId)) return; // Already claimed

                let progress = 0;
                if (challenge.type === 'taps') progress = userData.totalTaps || 0;
                if (challenge.type === 'ads') progress = userData.totalAdsWatched || 0;

                if (progress >= challenge.target) {
                    userData.score = (userData.score || 0) + challenge.reward;
                    if (!userData.claimedChallenges) userData.claimedChallenges = [];
                    userData.claimedChallenges.push(challengeId);
                    userData.lastChallengeReward = challenge.reward; // For response
                    return userData;
                } else {
                    return; // Not eligible, abort
                }
            });

            if (result.committed) {
                res.status(200).json({ success: true, amount: result.snapshot.val().lastChallengeReward });
            } else {
                res.status(400).json({ success: false, message: "Challenge not completed or already claimed." });
            }
        } catch (e) {
            res.status(500).json({ success: false, message: "Server error." });
        }
    });
});

// ==================================================================
// 8. AD REWARD SYSTEM (Server-Side)
// ==================================================================
exports.claimAdReward = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        const userId = await getAuthenticatedUser(req, res);
        if (!userId) return;

        const userRef = db.ref(`users/${userId}`);
        const AD_COOLDOWN_MINUTES = 2;
        const ADS_WATCH_LIMIT = 2;

        try {
            const result = await userRef.transaction(userData => {
                if (!userData || userData.isBanned) return;

                const now = Date.now();
                const cooldownStart = userData.adCooldownStart || 0;
                
                // If cooldown is over, reset the watch count
                let adsWatched = userData.adsWatchedCount || 0;
                if (now - cooldownStart >= (AD_COOLDOWN_MINUTES * 60 * 1000)) {
                    adsWatched = 0;
                }

                if (adsWatched >= ADS_WATCH_LIMIT) {
                    return; // Limit reached for this cycle
                }

                // Grant a random reward, determined by the server
                const minReward = 100;
                const maxReward = 1000;
                const reward = Math.floor(Math.random() * (maxReward - minReward + 1)) + minReward;

                userData.score = (userData.score || 0) + reward;
                userData.adsWatchedCount = adsWatched + 1;
                userData.totalAdsWatched = (userData.totalAdsWatched || 0) + 1;
                userData.lastAdReward = reward;

                // If limit is now reached, start the cooldown
                if (userData.adsWatchedCount >= ADS_WATCH_LIMIT) {
                    userData.adCooldownStart = now;
                }
                
                return userData;
            });

            if (result.committed) {
                res.status(200).json({ success: true, amount: result.snapshot.val().lastAdReward });
            } else {
                res.status(400).json({ success: false, message: "Ad reward not available yet or limit reached." });
            }
        } catch (e) {
            res.status(500).json({ success: false, message: "Server error." });
        }
    });
});

// ==================================================================
// 5. REAL LEADERBOARD (Server-Side)
// ==================================================================
exports.getLeaderboard = functions.https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
        try {
            // Query top 50 users by score
            const query = db.ref('users').orderByChild('score').limitToLast(50);
            const snapshot = await query.once('value');
            
            const leaderboard = [];
            snapshot.forEach(child => {
                const val = child.val();
                // Don't send sensitive data like email/IP
                leaderboard.unshift({ // unshift to reverse order (Highest first)
                    name: val.name || "Anonymous", 
                    score: val.score || 0
                });
            });

            res.status(200).json({ success: true, leaderboard: leaderboard });
        } catch (e) {
            res.status(500).json({ success: false, message: "Could not fetch leaderboard" });
        }
    });
});