const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/summaryController')
const { authenticate } = require('../middleware/auth')

router.use(authenticate)

router.get('/monthly-summary/:year/:month', ctrl.getMonthSummary)
router.get('/monthly-data', ctrl.getAllMonths)
router.get('/balance/daily/:year/:month', ctrl.getDailyBalance)

module.exports = router