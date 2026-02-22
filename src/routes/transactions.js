const express = require('express')
const router = express.Router()
const ctrl = require('../../src/controllers/transactionController')
const { authenticate } = require('../middleware/auth')

router.use(authenticate)

router.get('/', ctrl.list)
router.post('/', ctrl.create)
router.get('/month/:year/:month', ctrl.getByMonth)
router.get('/:id', ctrl.getById)
router.put('/:id', ctrl.update)
router.delete('/:id', ctrl.remove)

module.exports = router