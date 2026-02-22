const express = require('express')
const router = express.Router()

const authRoutes = require('./auth')
const transactionRoutes = require('./transactions')
const recurringRoutes = require('./recurring')
const categoryRoutes = require('./categories')
const summaryRoutes = require('./summary')

router.use('/auth', authRoutes)
router.use('/transactions', transactionRoutes)
router.use('/recurring-transactions', recurringRoutes)
router.use('/categories', categoryRoutes)
router.use('/', summaryRoutes)

module.exports = router