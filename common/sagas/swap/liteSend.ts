import { SagaIterator, delay } from 'redux-saga';
import { select, put, call, take, race, fork, cancel, takeEvery } from 'redux-saga/effects';
import { getOrigin, getPaymentAddress } from 'selectors/swap';
import {
  setUnitMeta,
  setCurrentTo,
  setCurrentValue,
  TypeKeys as TransactionTK,
  resetTransactionRequested
} from 'actions/transaction';
import { TypeKeys as WalletTK, setTokenBalancePending } from 'actions/wallet';
import { AppState } from 'reducers';
import { showNotification } from 'actions/notifications';
import { isSupportedUnit, isNetworkUnit } from 'selectors/config';
import { showLiteSend, configureLiteSend } from 'actions/swap';
import { TypeKeys as SwapTK } from 'actions/swap/constants';
import { isUnlocked, isEtherBalancePending } from 'selectors/wallet';

type SwapState = AppState['swap'];

export function* configureLiteSendSaga(): SagaIterator {
  const { amount, label }: SwapState['origin'] = yield select(getOrigin);
  const paymentAddress: SwapState['paymentAddress'] = yield call(fetchPaymentAddress);

  if (!paymentAddress) {
    yield put(showNotification('danger', 'Could not fetch payment address'));
    return yield put(showLiteSend(false));
  }

  const supportedUnit: boolean = yield select(isSupportedUnit, label);
  if (!supportedUnit) {
    return yield put(showLiteSend(false));
  }

  const unlocked: boolean = yield select(isUnlocked);
  yield put(showLiteSend(true));

  // wait for wallet to be unlocked to continue
  if (!unlocked) {
    yield take(WalletTK.WALLET_SET);
  }
  const isNetwrkUnit = yield select(isNetworkUnit, label);
  //if it's a token, manually scan for that tokens balance and wait for it to resolve
  if (!isNetwrkUnit) {
    yield put(setTokenBalancePending({ tokenSymbol: label }));
    yield take([
      WalletTK.WALLET_SET_TOKEN_BALANCE_FULFILLED,
      WalletTK.WALLET_SET_TOKEN_BALANCE_REJECTED
    ]);
  } else {
    const etherBalanceResolving: boolean = yield select(isEtherBalancePending);
    if (etherBalanceResolving) {
      yield take([WalletTK.WALLET_SET_BALANCE_FULFILLED, WalletTK.WALLET_SET_BALANCE_REJECTED]);
    }
  }

  yield put(setUnitMeta(label));
  yield put(setCurrentValue(amount.toString()));
  yield put(setCurrentTo(paymentAddress));
}

export function* handleConfigureLiteSend(): SagaIterator {
  while (true) {
    const liteSendProc = yield fork(configureLiteSendSaga);
    const result = yield race({
      transactionReset: take(TransactionTK.RESET_REQUESTED),
      userNavigatedAway: take(WalletTK.WALLET_RESET),
      bityPollingFinished: take(SwapTK.SWAP_STOP_POLL_BITY_ORDER_STATUS),
      shapeshiftPollingFinished: take(SwapTK.SWAP_STOP_POLL_SHAPESHIFT_ORDER_STATUS)
    });

    //if polling is finished we should clear state and hide this tab
    if (result.bityPollingFinished || result.shapeshiftPollingFinished) {
      //clear transaction state and cancel saga
      yield cancel(liteSendProc);
      yield put(showLiteSend(false));
      return yield put(resetTransactionRequested());
    }
    if (result.transactionReset) {
      yield cancel(liteSendProc);
    }

    // if wallet reset is called, that means the user navigated away from the page, so we cancel everything
    if (result.userNavigatedAway) {
      yield cancel(liteSendProc);
      yield put(showLiteSend(false));
      return yield put(configureLiteSend());
    }
    // else the user just swapped to a new wallet, and we'll race against liteSend again to re-apply
    // the same transaction parameters again
  }
}

export function* fetchPaymentAddress(): SagaIterator {
  const MAX_RETRIES = 5;
  let currentTry = 0;
  while (currentTry <= MAX_RETRIES) {
    yield call(delay, 500);
    const paymentAddress: SwapState['paymentAddress'] = yield select(getPaymentAddress);
    if (paymentAddress) {
      return paymentAddress;
    }
    currentTry++;
  }

  yield put(showNotification('danger', 'Payment address not found'));
  return false;
}

export default function* swapLiteSend(): SagaIterator {
  yield takeEvery(SwapTK.SWAP_CONFIGURE_LITE_SEND, handleConfigureLiteSend);
}
