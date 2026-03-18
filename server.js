const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// זמני בלבד - אחר כך נעביר ל-DB
const users = new Map();

function getUser(phone) {
  if (!users.has(phone)) {
    users.set(phone, {
      step: 'welcome',
      profile: {
        name: null,
        gender: null, // 1=בן, 2=בת
        age: null,
        weight: null,
        heightCm: null,
        bmi: null,
        fitnessLevel: null,       // 1 מתחיל / 2 בינוני / 3 חזק
        preferredDuration: null,  // 1/2/3
        currentLevel: null        // רמת התחלה בפועל
      },
      lastWorkout: {
        actualMinutes: null,
        difficultyFeedback: null
      }
    });
  }
  return users.get(phone);
}

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

function getGenderLabel(value) {
  if (value === '1') return 'בן';
  if (value === '2') return 'בת';
  return null;
}

function getFitnessLabel(value) {
  if (value === '1') return 'מתחיל';
  if (value === '2') return 'בינוני';
  if (value === '3') return 'חזק';
  return null;
}

function getDurationLabel(value) {
  if (value === '1') return 'עד 12 דקות';
  if (value === '2') return '12-18 דקות';
  if (value === '3') return '18-25 דקות';
  return null;
}

// קובע רמת התחלה לפי רמת כושר + BMI
function getStartingLevel(fitnessLevel, bmi) {
  if (fitnessLevel === '3') {
    if (bmi >= 35) return 1;
    return 2;
  }

  if (fitnessLevel === '2') {
    if (bmi >= 35) return 1;
    return 1;
  }

  // מתחיל
  return 1;
}

function getFirstWorkout(durationChoice) {
  if (durationChoice === '1') {
    return `האימון הראשון שלכם להיום 💪

אימון פול בודי – עד 12 דקות

3 סבבים:
- 20 סקוואטים
- 12 שכיבות שמיכה
- 20 לאנג'ים
- 30 שניות פלאנק

כשתסיימו, שלחו:
סיימתי`;
  }

  if (durationChoice === '2') {
    return `האימון הראשון שלכם להיום 💪

אימון פול בודי – 12-18 דקות

4 סבבים:
- 20 סקוואטים
- 15 שכיבות שמיכה
- 20 לאנג'ים
- 40 שניות פלאנק
- 20 mountain climbers

כשתסיימו, שלחו:
סיימתי`;
  }

  return `האימון הראשון שלכם להיום 💪

אימון פול בודי – 18-25 דקות

5 סבבים:
- 25 סקוואטים
- 18 שכיבות שמיכה
- 24 לאנג'ים
- 45 שניות פלאנק
- 20 mountain climbers
- 10 ברפי

כשתסיימו, שלחו:
סיימתי`;
}

app.post('/webhook', (req, res) => {
  const incomingMsg = (req.body.Body || '').trim();
  const normalized = incomingMsg.toLowerCase();
  const phone = req.body.From || 'unknown';

  const user = getUser(phone);
  const twiml = new twilio.twiml.MessagingResponse();

  // איפוס / התחלה מחדש
  if (normalized === 'start' || normalized === 'התחל') {
    user.step = 'welcome';
    user.profile = {
      name: null,
      gender: null,
      age: null,
      weight: null,
      heightCm: null,
      bmi: null,
      fitnessLevel: null,
      preferredDuration: null,
      currentLevel: null
    };
    user.lastWorkout = {
      actualMinutes: null,
      difficultyFeedback: null
    };
  }

  switch (user.step) {
    case 'welcome':
      twiml.message(`ברוכים הבאים לאימון היומי 💪
איזה כיף שהצטרפתם אלינו!`);
      twiml.message('איך קוראים לך?');
      user.step = 'ask_name';
      break;

    case 'ask_name':
      user.profile.name = incomingMsg;
      twiml.message(`מעולה ${user.profile.name} 🙌

האם מדובר בבן או בת?

1 - בן
2 - בת

ענו במספר בלבד.`);
      user.step = 'ask_gender';
      break;

    case 'ask_gender':
      if (!['1', '2'].includes(incomingMsg)) {
        twiml.message(`תבחרו אפשרות תקינה:

1 - בן
2 - בת

ענו במספר בלבד.`);
        break;
      }

      user.profile.gender = incomingMsg;
      twiml.message('בני כמה אתם?');
      user.step = 'ask_age';
      break;

    case 'ask_age':
      if (!isValidAge(incomingMsg)) {
        twiml.message('תכתבו גיל תקין במספרים בלבד.');
        break;
      }

      user.profile.age = Number(incomingMsg);
      twiml.message('מה המשקל שלכם בק"ג?');
      user.step = 'ask_weight';
      break;

    case 'ask_weight':
      if (!isValidWeight(incomingMsg)) {
        twiml.message('תכתבו משקל תקין במספרים בלבד.');
        break;
      }

      user.profile.weight = Number(incomingMsg);
      twiml.message('מה הגובה שלכם בס"מ?');
      user.step = 'ask_height';
      break;

    case 'ask_height':
      if (!isValidHeight(incomingMsg)) {
        twiml.message('תכתבו גובה תקין בס"מ, במספרים בלבד.');
        break;
      }

      user.profile.heightCm = Number(incomingMsg);
      user.profile.bmi = calculateBmi(user.profile.weight, user.profile.heightCm);

      twiml.message(`איך הייתם מדרגים את רמת הכושר שלכם?

1 - מתחיל
2 - בינוני
3 - חזק

ענו במספר בלבד.`);
      user.step = 'ask_fitness';
      break;

    case 'ask_fitness':
      if (!['1', '2', '3'].includes(incomingMsg)) {
        twiml.message(`תבחרו אפשרות תקינה:

1 - מתחיל
2 - בינוני
3 - חזק

ענו במספר בלבד.`);
        break;
      }

      user.profile.fitnessLevel = incomingMsg;

      // חישוב רמת פתיחה בפועל
      user.profile.currentLevel = getStartingLevel(
        user.profile.fitnessLevel,
        user.profile.bmi
      );

      twiml.message(`כמה זמן יש לכם בדרך כלל לאימון?

1 - עד 12 דקות
2 - 12-18 דקות
3 - 18-25 דקות

ענו במספר בלבד.`);
      user.step = 'ask_duration';
      break;

    case 'ask_duration':
      if (!['1', '2', '3'].includes(incomingMsg)) {
        twiml.message(`תבחרו אפשרות תקינה:

1 - עד 12 דקות
2 - 12-18 דקות
3 - 18-25 דקות

ענו במספר בלבד.`);
        break;
      }

      user.profile.preferredDuration = incomingMsg;
      user.step = 'registered';

      twiml.message(`מעולה ${user.profile.name} 💪

סיימנו את ההרשמה.

מין: ${getGenderLabel(user.profile.gender)}
רמת כושר: ${getFitnessLabel(user.profile.fitnessLevel)}
זמן אימון מועדף: ${getDurationLabel(user.profile.preferredDuration)}
BMI: ${user.profile.bmi}

נתחיל כבר היום!`);

      twiml.message(getFirstWorkout(user.profile.preferredDuration));
      break;

    case 'registered':
      if (normalized === 'סיימתי') {
        twiml.message(`אלופים 🔥

האימון להיום הושלם.

כמה זמן לקח לכם בפועל?
כתבו מספר בדקות בלבד.`);
        user.step = 'ask_actual_time';
        break;
      }

      if (normalized === 'אימון') {
        twiml.message(getFirstWorkout(user.profile.preferredDuration));
        break;
      }

      if (normalized === 'עזרה') {
        twiml.message(`פקודות זמינות:
אימון
סיימתי
התחל`);
        break;
      }

      twiml.message(`אני כאן 💪

אפשר לכתוב:
אימון
סיימתי
עזרה`);
      break;

    case 'ask_actual_time':
      if (!isValidMinutes(incomingMsg)) {
        twiml.message('תכתבו זמן תקין בדקות בלבד.');
        break;
      }

      user.lastWorkout.actualMinutes = Number(incomingMsg);

      twiml.message(`איך הרגיש האימון?

1 - קל מאוד
2 - קל
3 - בינוני
4 - קשה
5 - קשה מאוד

ענו במספר בלבד.`);
      user.step = 'waiting_feedback';
      break;

    case 'waiting_feedback':
      if (!['1', '2', '3', '4', '5'].includes(incomingMsg)) {
        twiml.message(`תדרגו מ-1 עד 5:

1 - קל מאוד
2 - קל
3 - בינוני
4 - קשה
5 - קשה מאוד`);
        break;
      }

      user.lastWorkout.difficultyFeedback = Number(incomingMsg);

      twiml.message(`מעולה, שמרתי את הפרטים ✅

זמן בפועל: ${user.lastWorkout.actualMinutes} דקות
דירוג קושי: ${user.lastWorkout.difficultyFeedback}

נתראה באימון הבא 💪`);
      user.step = 'registered';
      break;

    default:
      user.step = 'welcome';
      twiml.message(`ברוכים הבאים לאימון היומי 💪
איזה כיף שהצטרפתם אלינו!`);
      twiml.message('איך קוראים לך?');
      user.step = 'ask_name';
      break;
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});