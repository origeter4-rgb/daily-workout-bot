const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.send('Server is running');
});

function isValidAge(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 13 && n <= 120;
}

function isValidWeight(value) {
  const n = Number(value);
  return !Number.isNaN(n) && n >= 30 && n <= 300;
}

function isValidHeight(value) {
  const n = Number(value);
  return !Number.isNaN(n) && n >= 120 && n <= 230;
}

function isValidMinutes(value) {
  const n = Number(value);
  return !Number.isNaN(n) && n >= 1 && n <= 180;
}

function calculateBmi(weightKg, heightCm) {
  const heightM = heightCm / 100;
  return +(weightKg / (heightM * heightM)).toFixed(1);
}

function isFemale(user) {
  return String(user.gender) === '2';
}

function byGender(user, maleText, femaleText) {
  return isFemale(user) ? femaleText : maleText;
}

function getGenderLabel(value) {
  if (String(value) === '1') return 'בן';
  if (String(value) === '2') return 'בת';
  return '';
}

function getFitnessLabel(value, gender) {
  const female = String(gender) === '2';
  if (String(value) === '1') return female ? 'מתחילה' : 'מתחיל';
  if (String(value) === '2') return female ? 'בינונית' : 'בינוני';
  if (String(value) === '3') return female ? 'חזקה' : 'חזק';
  return '';
}

function getDurationLabel(value) {
  if (String(value) === '1') return 'עד 12 דקות';
  if (String(value) === '2') return '12-18 דקות';
  if (String(value) === '3') return '18-25 דקות';
  return '';
}

function getStartingLevel(fitnessLevel, bmi) {
  if (String(fitnessLevel) === '3') {
    if (bmi >= 35) return 1;
    return 2;
  }

  if (String(fitnessLevel) === '2') {
    if (bmi >= 35) return 1;
    return 1;
  }

  return 1;
}

async function getOrCreateUser(phone) {
  const existing = await pool.query(
    'SELECT * FROM users WHERE phone = $1 LIMIT 1',
    [phone]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const created = await pool.query(
    `INSERT INTO users (phone, conversation_step)
     VALUES ($1, 'welcome')
     RETURNING *`,
    [phone]
  );

  return created.rows[0];
}

async function refreshUser(phone) {
  const result = await pool.query(
    'SELECT * FROM users WHERE phone = $1 LIMIT 1',
    [phone]
  );
  return result.rows[0];
}

async function sendNextWorkout(user, twiml) {
  let workoutResult = await pool.query(
    `SELECT *
     FROM workouts
     WHERE level = $1
       AND workout_number = $2
       AND duration_group = $3
       AND is_active = TRUE
     ORDER BY id
     LIMIT 1`,
    [user.current_level, user.current_workout_index, user.preferred_duration]
  );

  if (workoutResult.rows.length === 0) {
    workoutResult = await pool.query(
      `SELECT *
       FROM workouts
       WHERE level = $1
         AND workout_number = $2
         AND is_active = TRUE
       ORDER BY ABS(duration_group - $3), id
       LIMIT 1`,
      [user.current_level, user.current_workout_index, user.preferred_duration]
    );
  }

  if (workoutResult.rows.length === 0) {
    twiml.message(
      byGender(
        user,
        'עדיין לא הוזן אימון מתאים לרמה ולזמן שלך. נעדכן את המאגר ונמשיך משם.',
        'עדיין לא הוזן אימון מתאים לרמה ולזמן שלך. נעדכן את המאגר ונמשיך משם.'
      )
    );
    return;
  }

  const workout = workoutResult.rows[0];

  const logResult = await pool.query(
    `INSERT INTO workout_logs (user_id, workout_id, created_at)
     VALUES ($1, $2, NOW())
     RETURNING id`,
    [user.id, workout.id]
  );

  await pool.query(
    `UPDATE users
     SET pending_workout_log_id = $1
     WHERE id = $2`,
    [logResult.rows[0].id, user.id]
  );

  twiml.message(workout.content);
}

app.post('/webhook', async (req, res) => {
  const incomingMsg = (req.body.Body || '').trim();
  const normalized = incomingMsg.toLowerCase();
  const phone = req.body.From || 'unknown';

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    let user = await getOrCreateUser(phone);

    if (normalized === 'start' || normalized === 'התחל') {
      await pool.query(
        `UPDATE users
         SET name = NULL,
             gender = NULL,
             age = NULL,
             weight_kg = NULL,
             height_cm = NULL,
             bmi = NULL,
             fitness_level = NULL,
             preferred_duration = NULL,
             current_level = 1,
             current_workout_index = 1,
             conversation_step = 'welcome',
             pending_workout_log_id = NULL,
             pending_actual_minutes = NULL
         WHERE id = $1`,
        [user.id]
      );

      user = await refreshUser(phone);
    }

    switch (user.conversation_step) {
      case 'welcome':
        twiml.message(`ברוך/ה הבא/ה לאימון היומי 💪
איזה כיף שהצטרפת!`);
        twiml.message('איך קוראים לך?');

        await pool.query(
          `UPDATE users
           SET conversation_step = 'ask_name'
           WHERE id = $1`,
          [user.id]
        );
        break;

      case 'ask_name':
        await pool.query(
          `UPDATE users
           SET name = $1,
               conversation_step = 'ask_gender'
           WHERE id = $2`,
          [incomingMsg, user.id]
        );

        twiml.message(`מעולה ${incomingMsg} 🙌

האם אתה בן או בת?

1 - בן
2 - בת

ענה במספר בלבד.`);
        break;

      case 'ask_gender':
        if (!['1', '2'].includes(incomingMsg)) {
          twiml.message(`בחר אפשרות תקינה:

1 - בן
2 - בת

ענה במספר בלבד.`);
          break;
        }

        await pool.query(
          `UPDATE users
           SET gender = $1,
               conversation_step = 'ask_age'
           WHERE id = $2`,
          [incomingMsg, user.id]
        );

        user = await refreshUser(phone);

        twiml.message(byGender(user, 'בן כמה אתה?', 'בת כמה את?'));
        break;

      case 'ask_age':
        if (!isValidAge(incomingMsg)) {
          twiml.message(byGender(user, 'תכתוב גיל תקין במספרים בלבד.', 'תכתבי גיל תקין במספרים בלבד.'));
          break;
        }

        await pool.query(
          `UPDATE users
           SET age = $1,
               conversation_step = 'ask_weight'
           WHERE id = $2`,
          [Number(incomingMsg), user.id]
        );

        user = await refreshUser(phone);

        twiml.message(byGender(user, 'מה המשקל שלך בק"ג?', 'מה המשקל שלך בק"ג?'));
        break;

      case 'ask_weight':
        if (!isValidWeight(incomingMsg)) {
          twiml.message(byGender(user, 'תכתוב משקל תקין במספרים בלבד.', 'תכתבי משקל תקין במספרים בלבד.'));
          break;
        }

        await pool.query(
          `UPDATE users
           SET weight_kg = $1,
               conversation_step = 'ask_height'
           WHERE id = $2`,
          [Number(incomingMsg), user.id]
        );

        user = await refreshUser(phone);

        twiml.message(byGender(user, 'מה הגובה שלך בס"מ?', 'מה הגובה שלך בס"מ?'));
        break;

      case 'ask_height':
        if (!isValidHeight(incomingMsg)) {
          twiml.message(byGender(user, 'תכתוב גובה תקין בס"מ, במספרים בלבד.', 'תכתבי גובה תקין בס"מ, במספרים בלבד.'));
          break;
        }

        {
          const weight = Number(user.weight_kg);
          const height = Number(incomingMsg);
          const bmi = calculateBmi(weight, height);

          await pool.query(
            `UPDATE users
             SET height_cm = $1,
                 bmi = $2,
                 conversation_step = 'ask_fitness'
             WHERE id = $3`,
            [height, bmi, user.id]
          );

          user = await refreshUser(phone);

          twiml.message(`איך היית ${byGender(user, 'מדרג', 'מדרגת')} את רמת הכושר שלך?

1 - מתחיל/ה
2 - בינוני/ת
3 - חזק/ה

ענה במספר בלבד.`);
        }
        break;

      case 'ask_fitness':
        if (!['1', '2', '3'].includes(incomingMsg)) {
          twiml.message(`בחר אפשרות תקינה:

1 - מתחיל/ה
2 - בינוני/ת
3 - חזק/ה

ענה במספר בלבד.`);
          break;
        }

        {
          const startingLevel = getStartingLevel(incomingMsg, Number(user.bmi));

          await pool.query(
            `UPDATE users
             SET fitness_level = $1,
                 current_level = $2,
                 conversation_step = 'ask_duration'
             WHERE id = $3`,
            [Number(incomingMsg), startingLevel, user.id]
          );

          user = await refreshUser(phone);

          twiml.message(byGender(
            user,
            `כמה זמן יש לך בדרך כלל לאימון?

1 - עד 12 דקות
2 - 12-18 דקות
3 - 18-25 דקות

ענה במספר בלבד.`,
            `כמה זמן יש לך בדרך כלל לאימון?

1 - עד 12 דקות
2 - 12-18 דקות
3 - 18-25 דקות

עני במספר בלבד.`
          ));
        }
        break;

      case 'ask_duration':
        if (!['1', '2', '3'].includes(incomingMsg)) {
          twiml.message(byGender(
            user,
            `בחר אפשרות תקינה:

1 - עד 12 דקות
2 - 12-18 דקות
3 - 18-25 דקות

ענה במספר בלבד.`,
            `בחרי אפשרות תקינה:

1 - עד 12 דקות
2 - 12-18 דקות
3 - 18-25 דקות

עני במספר בלבד.`
          ));
          break;
        }

        await pool.query(
          `UPDATE users
           SET preferred_duration = $1,
               conversation_step = 'registered'
           WHERE id = $2`,
          [Number(incomingMsg), user.id]
        );

        user = await refreshUser(phone);

        twiml.message(`מעולה ${user.name} 💪

סיימנו את ההרשמה.

מין: ${getGenderLabel(user.gender)}
רמת כושר: ${getFitnessLabel(user.fitness_level, user.gender)}
זמן אימון מועדף: ${getDurationLabel(user.preferred_duration)}
BMI: ${user.bmi}

${byGender(user, 'נתחיל כבר היום!', 'נתחיל כבר היום!')}`);

        await sendNextWorkout(user, twiml);
        break;

      case 'registered':
        if (normalized === 'סיימתי') {
          if (!user.pending_workout_log_id) {
            twiml.message(byGender(
              user,
              'אין כרגע אימון פתוח לעדכון. תכתוב "אימון" כדי לקבל את האימון הבא.',
              'אין כרגע אימון פתוח לעדכון. תכתבי "אימון" כדי לקבל את האימון הבא.'
            ));
            break;
          }

          await pool.query(
            `UPDATE users
             SET conversation_step = 'ask_actual_time'
             WHERE id = $1`,
            [user.id]
          );

          twiml.message(`${byGender(user, 'אלוף', 'אלופה')} 🔥

האימון להיום הושלם.

${byGender(user, 'כמה זמן לקח לך בפועל?', 'כמה זמן לקח לך בפועל?')}
${byGender(user, 'תכתוב מספר בדקות בלבד.', 'תכתבי מספר בדקות בלבד.')}`);
          break;
        }

        if (normalized === 'אימון') {
          await sendNextWorkout(user, twiml);
          break;
        }

        if (normalized === 'עזרה') {
          twiml.message(byGender(
            user,
            `פקודות זמינות:
אימון
סיימתי
התחל`,
            `פקודות זמינות:
אימון
סיימתי
התחל`
          ));
          break;
        }

        twiml.message(byGender(
          user,
          `אני כאן 💪

אפשר לכתוב:
אימון
סיימתי
עזרה`,
          `אני כאן 💪

אפשר לכתוב:
אימון
סיימתי
עזרה`
        ));
        break;

      case 'ask_actual_time':
        if (!isValidMinutes(incomingMsg)) {
          twiml.message(byGender(user, 'תכתוב זמן תקין בדקות בלבד.', 'תכתבי זמן תקין בדקות בלבד.'));
          break;
        }

        await pool.query(
          `UPDATE users
           SET pending_actual_minutes = $1,
               conversation_step = 'waiting_feedback'
           WHERE id = $2`,
          [Number(incomingMsg), user.id]
        );

        twiml.message(byGender(
          user,
          `איך הרגיש לך האימון?

1 - קל מאוד
2 - קל
3 - בינוני
4 - קשה
5 - קשה מאוד

ענה במספר בלבד.`,
          `איך הרגיש לך האימון?

1 - קל מאוד
2 - קל
3 - בינוני
4 - קשה
5 - קשה מאוד

עני במספר בלבד.`
        ));
        break;

      case 'waiting_feedback':
        if (!['1', '2', '3', '4', '5'].includes(incomingMsg)) {
          twiml.message(byGender(
            user,
            `תדרג מ-1 עד 5:

1 - קל מאוד
2 - קל
3 - בינוני
4 - קשה
5 - קשה מאוד`,
            `תדרגי מ-1 עד 5:

1 - קל מאוד
2 - קל
3 - בינוני
4 - קשה
5 - קשה מאוד`
          ));
          break;
        }

        {
          const difficulty = Number(incomingMsg);
          const actualMinutes = user.pending_actual_minutes || null;

          if (user.pending_workout_log_id) {
            await pool.query(
              `UPDATE workout_logs
               SET completed = TRUE,
                   skipped = FALSE,
                   actual_minutes = $1,
                   difficulty_feedback = $2,
                   completed_at = NOW()
               WHERE id = $3`,
              [actualMinutes, difficulty, user.pending_workout_log_id]
            );
          }

          let nextWorkoutIndex = user.current_workout_index;

          if (difficulty <= 3) {
            nextWorkoutIndex = user.current_workout_index + 1;
          }

          await pool.query(
            `UPDATE users
             SET current_workout_index = $1,
                 conversation_step = 'registered',
                 pending_workout_log_id = NULL,
                 pending_actual_minutes = NULL
             WHERE id = $2`,
            [nextWorkoutIndex, user.id]
          );

          twiml.message(`מעולה, שמרתי את הפרטים ✅

זמן בפועל: ${actualMinutes} דקות
דירוג קושי: ${difficulty}

${byGender(user, 'נתראה באימון הבא 💪', 'נתראה באימון הבא 💪')}`);
        }
        break;

      default:
        await pool.query(
          `UPDATE users
           SET conversation_step = 'welcome'
           WHERE id = $1`,
          [user.id]
        );

        twiml.message(`ברוך/ה הבא/ה לאימון היומי 💪
איזה כיף שהצטרפת!`);
        twiml.message('איך קוראים לך?');
        break;
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  } catch (error) {
    console.error('Webhook error:', error);
    const fallback = new twilio.twiml.MessagingResponse();
    fallback.message('הייתה תקלה זמנית במערכת. נסה/י שוב בעוד רגע.');
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(fallback.toString());
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});